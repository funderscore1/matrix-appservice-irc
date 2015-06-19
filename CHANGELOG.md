Changes in 0.1.1
================
 - Added config option `ircClients.idleTimeout` to allow virtual IRC clients to
   timeout after a specified amount of time.
 - Replaced `check.sh` with `npm run lint` and `npm run check`.
 - Strip unknown HTML tags from Matrix messages before sending to IRC.
 - Don't try to leave Matrix rooms if the IRC user who left is a virtual user.
 - **Deprecate** `dynamicChannels.visibility` in favour of
   `dynamicChannels.createAlias`, `dynamicChannels.published` and
   `dynamicChannels.joinRule` which gives more control over how the AS creates
   dynamic rooms.
 - Listen for `+k` and `+i` modes and change the `join_rules` of the Matrix
   room to `invite` when they are set. Revert back to the YAML configured
   `join_rules` when these modes are removed.