---
description: Read team notes as a conversation, or one person's thread
argument-hint: "[teammate name, or blank for the team feed]"
---

# Read the notes as a conversation

1. Call the teamshare `history` tool.
   - If this command has arguments, pass them as `with` — they name a
     teammate, and the tool resolves a name, a nickname or an address.
   - If it has none, call it with no arguments for the team-wide feed.
2. **Print what it returns exactly as written**, inside a fenced code block so
   the alignment survives.

Do not summarise it, reorder it, add commentary between the lines, or turn it
into a bulleted list. The user asked to read the conversation, and a
paraphrase of a transcript is not a transcript. The tool has already done the
formatting, including the dates, the day headings and the speaker column.

Say nothing before or after it beyond one short line if something needs
explaining — for example that only the most recent notes are shown, which the
tool's own output already states.

If the name matches two teammates, the tool says so and names both. Relay
that, ask which one, and call it again with the address it gave you.

If the teamshare tools are unavailable, tell the user the connection is down
and point them at `/teamshare:status`. Do not retry.
