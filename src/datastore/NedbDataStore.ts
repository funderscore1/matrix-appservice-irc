/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {default as Bluebird} from "bluebird";
import { IrcRoom } from "../models/IrcRoom";
import { IrcClientConfig, IrcClientConfigSeralized } from "../models/IrcClientConfig"
import * as logging from "../logging";

// Ignore definition errors for now.
//@ts-ignore
import { MatrixRoom, MatrixUser, RemoteUser, RemoteRoom, UserBridgeStore, RoomBridgeStore, Entry } from "matrix-appservice-bridge";
import { DataStore, RoomOrigin, ChannelMappings, UserFeatures } from "./DataStore";
import { IrcServer, IrcServerConfig } from "../irc/IrcServer";
import { StringCrypto } from "./StringCrypto";
import Nedb from "nedb";

const log = logging.get("NeDBDataStore");


export class NeDBDataStore implements DataStore {
    private serverMappings: {[domain: string]: IrcServer} = {};
    private cryptoStore?: StringCrypto;
    constructor(
        private userStore: UserBridgeStore,
        private roomStore: RoomBridgeStore,
        pkeyPath: string,
        private bridgeDomain: string) {
        const errLog = function(fieldName: string) {
            return (err: Error) => {
                if (err) {
                    log.error("Failed to ensure '%s' index on store: " + err, fieldName);
                    return;
                }
                log.info("Indexes checked on '%s' for store.", fieldName);
            };
        };

        // add some indexes
        this.roomStore.db.ensureIndex({
            fieldName: "id",
            unique: true,
            sparse: false
        }, errLog("id"));
        this.roomStore.db.ensureIndex({
            fieldName: "matrix_id",
            unique: false,
            sparse: true
        }, errLog("matrix_id"));
        this.roomStore.db.ensureIndex({
            fieldName: "remote_id",
            unique: false,
            sparse: true
        }, errLog("remote_id"));
        this.userStore.db.ensureIndex({
            fieldName: "data.localpart",
            unique: false,
            sparse: true
        }, errLog("localpart"));
        this.userStore.db.ensureIndex({
            fieldName: "id",
            unique: true,
            sparse: false
        }, errLog("user id"));

        if (pkeyPath) {
            this.cryptoStore = new StringCrypto();
            this.cryptoStore.load(pkeyPath);
        }
        // Cache as many mappings as possible for hot paths like message sending.

        // TODO: cache IRC channel -> [room_id] mapping (only need to remove them in
        //       removeRoom() which is infrequent)
        // TODO: cache room_id -> [#channel] mapping (only need to remove them in
        //       removeRoom() which is infrequent)
    }

    public async setServerFromConfig(server: IrcServer, serverConfig: IrcServerConfig): Promise<void> {
        this.serverMappings[server.domain] = server;

        for (const channel of Object.keys(serverConfig.mappings)) {
            const ircRoom = new IrcRoom(server, channel);
            for (const roomId of serverConfig.mappings[channel]) {
                const mxRoom = new MatrixRoom(roomId);
                await this.storeRoom(ircRoom, mxRoom, "config");
            }
        }

        // Some kinds of users may have the same user_id prefix so will cause ident code to hit
        // getMatrixUserByUsername hundreds of times which can be slow:
        // https://github.com/matrix-org/matrix-appservice-irc/issues/404
        const domainKey = server.domain.replace(/\./g, "_");
        this.userStore.db.ensureIndex({
            fieldName: "data.client_config." + domainKey + ".username",
            unique: true,
            sparse: true
        }, (err: Error) => {
            if (err) {
                log.error("Failed to ensure ident username index on users database!");
                return;
            }
            log.info("Indexes checked for ident username for " + server.domain + " on users database");
        });
    }

    /**
     * Persists an IRC <--> Matrix room mapping in the database.
     * @param {IrcRoom} ircRoom : The IRC room to store.
     * @param {MatrixRoom} matrixRoom : The Matrix room to store.
     * @param {string} origin : "config" if this mapping is from the config yaml,
     * "provision" if this mapping was provisioned, "alias" if it was created via
     * aliasing and "join" if it was created during a join.
     * @return {Promise}
     */
    public async storeRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, origin: RoomOrigin): Promise<void> {
        if (typeof origin !== "string") {
            throw new Error('Origin must be a string = "config"|"provision"|"alias"|"join"');
        }

        log.info("storeRoom (id=%s, addr=%s, chan=%s, origin=%s)",
            matrixRoom.getId(), ircRoom.getDomain(), ircRoom.channel, origin);

        const mappingId = NeDBDataStore.createMappingId(matrixRoom.getId(), ircRoom.getDomain(), ircRoom.channel);
        await this.roomStore.linkRooms(matrixRoom, ircRoom, {
            origin: origin
        }, mappingId);
    }

    /**
     * Get an IRC <--> Matrix room mapping from the database.
     * @param {string} roomId : The Matrix room ID.
     * @param {string} ircDomain : The IRC server domain.
     * @param {string} ircChannel : The IRC channel.
     * @param {string} origin : (Optional) "config" if this mapping was from the config yaml,
     * "provision" if this mapping was provisioned, "alias" if it was created via aliasing and
     * "join" if it was created during a join.
     * @return {Promise} A promise which resolves to a room entry, or null if one is not found.
     */
    public async getRoom(roomId: string, ircDomain: string,
                         ircChannel: string, origin?: RoomOrigin): Promise<Entry|null> {
        if (origin && typeof origin !== "string") {
            throw new Error(`If defined, origin must be a string =
                "config"|"provision"|"alias"|"join"`);
        }
        const mappingId = NeDBDataStore.createMappingId(roomId, ircDomain, ircChannel);
        return this.roomStore.getEntryById(mappingId).then(
            (entry) => {
                if (origin && entry !== null && origin !== entry.data!.origin) {
                    return null;
                }
                return entry;
        });
    }

    /**
     * Get all Matrix <--> IRC room mappings from the database.
     * @return {Promise} A promise which resolves to a map:
     *      $roomId => [{networkId: 'server #channel1', channel: '#channel2'} , ...]
     */
    public async getAllChannelMappings(): Promise<ChannelMappings> {
        const entries = await this.roomStore.select(
            {
                matrix_id: {$exists: true},
                remote_id: {$exists: true},
                'remote.type': "channel"
            }
        );

        const mappings: ChannelMappings = {};

        entries.forEach((e: any) => {
            const domain = e.remote.domain;
            const channel = e.remote.channel;
            // drop unknown irc networks in the database
            if (!this.serverMappings[domain]) {
                return;
            }
            if (!mappings[e.matrix_id]) {
                mappings[e.matrix_id] = [];
            }
            mappings[e.matrix_id].push({
                networkId: this.serverMappings[domain].getNetworkId(),
                channel,
            });
        });

        return mappings;
    }

    /**
     * Get provisioned IRC <--> Matrix room mappings from the database where
     * the matrix room ID is roomId.
     * @param {string} roomId : The Matrix room ID.
     * @return {Promise} A promise which resolves to a list
     * of entries.
     */
    public getProvisionedMappings(roomId: string): Bluebird<Entry[]> {
        return Bluebird.cast(this.roomStore.getEntriesByMatrixId(roomId)).filter(
            (entry: Entry) => {
                return entry.data && entry.data.origin === 'provision'
            }
        );
    }

    /**
     * Remove an IRC <--> Matrix room mapping from the database.
     * @param {string} roomId : The Matrix room ID.
     * @param {string} ircDomain : The IRC server domain.
     * @param {string} ircChannel : The IRC channel.
     * @param {string} origin : "config" if this mapping was from the config yaml,
     * "provision" if this mapping was provisioned, "alias" if it was created via
     * aliasing and "join" if it was created during a join.
     * @return {Promise}
     */
    public async removeRoom(roomId: string, ircDomain: string, ircChannel: string, origin: RoomOrigin): Promise<void> {
        if (typeof origin !== 'string') {
            throw new Error('Origin must be a string = "config"|"provision"|"alias"|"join"');
        }

        return await this.roomStore.delete({
            id: NeDBDataStore.createMappingId(roomId, ircDomain, ircChannel),
            'data.origin': origin
        });
    }

    /**
     * Retrieve a list of IRC rooms for a given room ID.
     * @param {string} roomId : The room ID to get mapped IRC channels.
     * @return {Promise<Array<IrcRoom>>} A promise which resolves to a list of
     * rooms.
     */
    public async getIrcChannelsForRoomId(roomId: string): Promise<IrcRoom[]> {
        return this.roomStore.getLinkedRemoteRooms(roomId).then((remoteRooms: RemoteRoom[]) => {
            return remoteRooms.filter((remoteRoom) => {
                return Boolean(this.serverMappings[remoteRoom.get("domain") as string]);
            }).map((remoteRoom) => {
                const server = this.serverMappings[remoteRoom.get("domain") as string];
                return IrcRoom.fromRemoteRoom(server, remoteRoom);
            });
        });
    }

    /**
     * Retrieve a list of IRC rooms for a given list of room IDs. This is significantly
     * faster than calling getIrcChannelsForRoomId for each room ID.
     * @param {string[]} roomIds : The room IDs to get mapped IRC channels.
     * @return {Promise<Map<string, IrcRoom[]>>} A promise which resolves to a map of
     * room ID to an array of IRC rooms.
     */
    public async getIrcChannelsForRoomIds(roomIds: string[]): Promise<{[roomId: string]: IrcRoom[]}> {
        const roomIdToRemoteRooms: {
            [roomId: string]: IrcRoom[];
        } = {};
        const linkedRemoteRooms = await this.roomStore.batchGetLinkedRemoteRooms(roomIds);
        for (const roomId of Object.keys(linkedRemoteRooms)) {
            // filter out rooms with unknown IRC servers and
            // map RemoteRooms to IrcRooms
            roomIdToRemoteRooms[roomId] = linkedRemoteRooms[roomId].filter((remoteRoom) => {
                return Boolean(this.serverMappings[remoteRoom.get("domain") as string]);
            }).map((remoteRoom) => {
                const server = this.serverMappings[remoteRoom.get("domain") as string];
                return IrcRoom.fromRemoteRoom(server, remoteRoom);
            });
        }
        return roomIdToRemoteRooms;
    }

    /**
     * Retrieve a list of Matrix rooms for a given server and channel.
     * @param {IrcServer} server : The server to get rooms for.
     * @param {string} channel : The channel to get mapped rooms for.
     * @return {Promise<Array<MatrixRoom>>} A promise which resolves to a list of rooms.
     */
    public async getMatrixRoomsForChannel(server: IrcServer, channel: string): Promise<MatrixRoom[]> {
        const ircRoom = new IrcRoom(server, channel);
        return await this.roomStore.getLinkedMatrixRooms(
            IrcRoom.createId(ircRoom.getServer(), ircRoom.getChannel())
        );
    }

    public async getMappingsForChannelByOrigin(server: IrcServer, channel: string,
                                               origin: RoomOrigin|RoomOrigin[], allowUnset: boolean) {
        if (typeof origin === "string") {
            origin = [origin];
        }

        if (!Array.isArray(origin) || !origin.every((s) => typeof s === "string")) {
            throw new Error("origin must be string or array of strings");
        }

        const remoteId = IrcRoom.createId(server, channel);
        return this.roomStore.getEntriesByRemoteId(remoteId).then((entries: Entry[]) => {
            return entries.filter((e) => {
                if (allowUnset) {
                    if (!e.data || !e.data.origin) {
                        return true;
                    }
                }
                return e.data && origin.indexOf(e.data.origin) !== -1;
            });
        });
    }

    public async getModesForChannel (server: IrcServer, channel: string): Promise<{[id: string]: string[]}> {
        log.info("getModesForChannel (server=%s, channel=%s)",
            server.domain, channel
        );
        const remoteId = IrcRoom.createId(server, channel);
        const entries = await this.roomStore.getEntriesByRemoteId(remoteId);
        const mapping: {[id: string]: string[]} = {};
        entries.forEach((entry) => {
            mapping[entry.matrix!.getId()] = entry.remote!.get("modes") as string[] || [];
        });
        return mapping;
    }

    public async setModeForRoom(roomId: string, mode: string, enabled = true): Promise<void> {
        log.info("setModeForRoom (mode=%s, roomId=%s, enabled=%s)",
            mode, roomId, enabled
        );
        const entries: Entry[] = await this.roomStore.getEntriesByMatrixId(roomId);
        for (const entry of entries) {
            if (!entry.remote) {
                return;
            }
            const modes = entry.remote.get("modes") as string[] || [];
            const hasMode = modes.includes(mode);

            if (hasMode === enabled) {
                continue;
            }
            if (enabled) {
                modes.push(mode);
            }
            else {
                modes.splice(modes.indexOf(mode), 1);
            }

            entry.remote.set("modes", modes);

            this.roomStore.upsertEntry(entry);
        }
    }

    public async setPmRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom,
                           userId: string, virtualUserId: string): Promise<void> {
        log.info("setPmRoom (id=%s, addr=%s chan=%s real=%s virt=%s)",
            matrixRoom.getId(), ircRoom.server.domain, ircRoom.channel, userId,
            virtualUserId);

        await this.roomStore.linkRooms(matrixRoom, ircRoom, {
            real_user_id: userId,
            virtual_user_id: virtualUserId
        }, NeDBDataStore.createPmId(userId, virtualUserId));
    }

    public async getMatrixPmRoom(realUserId: string, virtualUserId: string) {
        const id = NeDBDataStore.createPmId(realUserId, virtualUserId);
        const entry = await this.roomStore.getEntryById(id);
        if (!entry) {
            return null;
        }
        return entry.matrix;
    }

    public async getTrackedChannelsForServer(domain: string) {
        const entries: Entry[] = await this.roomStore.getEntriesByRemoteRoomData({ domain });
        const channels: string[] = [];
        entries.forEach((e) => {
            const r = e.remote!;
            const server = this.serverMappings[r.get("domain") as string];
            if (!server) {
                return;
            }
            const ircRoom = IrcRoom.fromRemoteRoom(server, r);
            if (ircRoom.getType() === "channel") {
                channels.push(ircRoom.getChannel());
            }
        });
        return channels;
    }

    public async getRoomIdsFromConfig() {
        const entries: Entry[] = await this.roomStore.getEntriesByLinkData({
            origin: 'config'
        });
        return entries.map((e) => 
            e.matrix!.getId()
        );
    }

    public async removeConfigMappings() {
        await this.roomStore.removeEntriesByLinkData({
            from_config: true // for backwards compatibility
        });
        await this.roomStore.removeEntriesByLinkData({
            origin: 'config'
        });
    }

    public async getIpv6Counter(): Promise<number> {
        let config = await this.userStore.getRemoteUser("config");
        if (!config) {
            config = new RemoteUser("config");
            config.set("ipv6_counter", 0);
            await this.userStore.setRemoteUser(config);
        }
        return config.get("ipv6_counter") as number;
    }


    public async setIpv6Counter(counter: number) {
        let config = await this.userStore.getRemoteUser("config");
        if (!config) {
            config = new RemoteUser("config");
        }
        config.set("ipv6_counter", counter);
        await this.userStore.setRemoteUser(config);
    }

    /**
     * Retrieve a stored admin room based on the room's ID.
     * @param {String} roomId : The room ID of the admin room.
     * @return {Promise} Resolved when the room is retrieved.
     */
    public async getAdminRoomById(roomId: string): Promise<MatrixRoom|null> {
        const entries: Entry[] = await this.roomStore.getEntriesByMatrixId(roomId);
        if (entries.length == 0) {
            return null;
        }
        if (entries.length > 1) {
            log.error("getAdminRoomById(" + roomId + ") has " + entries.length + " entries");
        }
        if (entries[0].matrix && entries[0].matrix.get("admin_id")) {
            return entries[0].matrix;
        }
        return null;
    }

    /**
     * Stores a unique admin room for a given user ID.
     * @param {MatrixRoom} room : The matrix room which is the admin room for this user.
     * @param {String} userId : The user ID who is getting an admin room.
     * @return {Promise} Resolved when the room is stored.
     */
    public async storeAdminRoom(room: MatrixRoom, userId: string): Promise<void> {
        log.info("storeAdminRoom (id=%s, user_id=%s)", room.getId(), userId);
        room.set("admin_id", userId);
        await this.roomStore.upsertEntry({
            id: NeDBDataStore.createAdminId(userId),
            matrix_id: room.getId(),
            matrix: room,
            remote: null,
            remote_id: "",
            data: {},
        });
    }

    public async upsertRoomStoreEntry(entry: Entry): Promise<void> {
        await this.roomStore.upsertEntry(entry);
    }

    public async getAdminRoomByUserId(userId: string): Promise<MatrixRoom|null> {
        const entry = await this.roomStore.getEntryById(NeDBDataStore.createAdminId(userId));
        if (!entry) {
            return null;
        }
        return entry.matrix;
    }

    public async storeMatrixUser(matrixUser: MatrixUser): Promise<void> {
        await this.userStore.setMatrixUser(matrixUser);
    }

    public async getIrcClientConfig(userId: string, domain: string): Promise<IrcClientConfig|null> {
        const matrixUser = await this.userStore.getMatrixUser(userId);
        if (!matrixUser) {
            return null;
        }
        const userConfig = matrixUser.get("client_config") as any;
        if (!userConfig) {
            return null;
        }
        // map back from _ to .
        Object.keys(userConfig).forEach(function(domainWithUnderscores) {
            const actualDomain = domainWithUnderscores.replace(/_/g, ".");
            if (actualDomain !== domainWithUnderscores) { // false for 'localhost'
                userConfig[actualDomain] = userConfig[domainWithUnderscores];
                delete userConfig[domainWithUnderscores];
            }
        })
        const configData = userConfig[domain];
        if (!configData) {
            return null;
        }
        const clientConfig = new IrcClientConfig(userId, domain, configData);
        const encryptedPass = clientConfig.getPassword();
        if (encryptedPass) {
            if (!this.cryptoStore) {
                throw new Error(`Cannot decrypt password of ${userId} - no private key`);
            }
            const decryptedPass = this.cryptoStore.decrypt(encryptedPass);
            clientConfig.setPassword(decryptedPass);
        }
        return clientConfig;
    }

    public async getMatrixUserByLocalpart(localpart: string): Promise<MatrixUser|null> {
        return await this.userStore.getMatrixUser(`@${localpart}:${this.bridgeDomain}`);
    }

    public async storeIrcClientConfig(config: IrcClientConfig) {
        const userId = config.getUserId();
        if (!userId) {
            throw Error("No userId defined in config");
        }
        let user = await this.userStore.getMatrixUser(userId);
        if (!user) {
            user = new MatrixUser(userId);
        }
        const userConfig = user.get("client_config") as any || {};
        const password = config.getPassword();
        if (password) {
            if (!this.cryptoStore) {
                throw new Error(
                    'Cannot store plaintext passwords'
                );
            }
            const encryptedPass = this.cryptoStore.encrypt(password);
            // Store the encrypted password, ready for the db
            config.setPassword(encryptedPass);
        }
        userConfig[config.getDomain().replace(/\./g, "_")] = config.serialize();
        user.set("client_config", userConfig);
        await this.userStore.setMatrixUser(user);
    }

    public async getUserFeatures(userId: string): Promise<UserFeatures> {
        const matrixUser = await this.userStore.getMatrixUser(userId);
        return matrixUser ? (matrixUser.get("features") as UserFeatures || {}) : {};
    }

    public async storeUserFeatures(userId: string, features: UserFeatures) {
        let matrixUser = await this.userStore.getMatrixUser(userId);
        if (!matrixUser) {
            matrixUser = new MatrixUser(userId);
        }
        matrixUser.set("features", features);
        await this.userStore.setMatrixUser(matrixUser);
    }

    public async storePass(userId: string, domain: string, pass: string) {
        const config = await this.getIrcClientConfig(userId, domain);
        if (!config) {
            throw new Error(`${userId} does not have an IRC client configured for ${domain}`);
        }
        config.setPassword(pass);
        await this.storeIrcClientConfig(config);
    }

    public async removePass(userId: string, domain: string) {
        const config = await this.getIrcClientConfig(userId, domain);
        if (config) {
            config.setPassword();
            await this.storeIrcClientConfig(config);
        }
    }

    public async getMatrixUserByUsername(domain: string, username: string): Promise<MatrixUser|undefined> {
        const domainKey = domain.replace(/\./g, "_");
        const matrixUsers = await this.userStore.getByMatrixData({
            ["client_config." + domainKey + ".username"]: username
        });

        if (matrixUsers.length > 1) {
            log.error(
                "getMatrixUserByUsername return %s results for %s on %s",
                matrixUsers.length, username, domain
            );
        }
        return matrixUsers[0];
    }

    private static createPmId(userId: string, virtualUserId: string) {
        // space as delimiter as none of these IDs allow spaces.
        return "PM_" + userId + " " + virtualUserId; // clobber based on this.
    }

    private static createAdminId(userId: string) {
        return "ADMIN_" + userId; // clobber based on this.
    }

    private static createMappingId(roomId: string, ircDomain: string, ircChannel: string) {
        // space as delimiter as none of these IDs allow spaces.
        return roomId + " " + ircDomain + " " + ircChannel; // clobber based on this
    }
}