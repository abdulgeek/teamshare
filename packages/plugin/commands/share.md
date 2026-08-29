---
description: Share context with the team via teamshare
argument-hint: "[what you want the team to know]"
---

# Share with the team

Publish a short, high-signal note that every teammate's agent surfaces at their
next session start.

1. Use the `share-format` skill to distill the user's message — the arguments to
   this command, or if empty, ask what they want to share.
2. Show the formatted share and get confirmation.
3. Call the teamshare `share` tool.
4. Report the share id and the number of teammates who will be notified.

If the teamshare tools are not available, tell the user the connection is down
(check `/mcp`, or reconfigure via `/plugin` if this machine was never configured)
and do not retry.
