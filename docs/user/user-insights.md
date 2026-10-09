# User insights

User insights learn how you write and work from the messages you type: your language, how long
and how direct your messages are, your stack, how you check results, and what you usually ask
next. Once esveo code has seen enough, it offers up to three next messages above the composer
after a turn finishes, written the way you would write them. Picking one fills the composer;
nothing is sent until you send it.

User insights are off by default and only learn from messages you type in the web, desktop and
mobile apps. Messages from agents, scheduled tasks and other threads are left out.

## Turning it on

Open **Settings** > **General** and turn on **User insights**. Learning starts with your next
message. Suggestions start once about 40 messages are learned and the profile is confident enough.
The settings section shows how far learning is.

To get there sooner, **Import past messages** learns from what you typed in this server's threads
during the last 30 days, the newest 300 messages at most, together with the end of the agent reply
each one answered. Before it starts, it shows how many messages it found, how many updates that
takes and their estimated cost, since every update is a Claude call. The import runs in the
background, older messages count less, and it pauses at the daily cap and continues the next day.
You can cancel it while it runs.

**Prompt suggestions** turns the suggestions off without stopping learning. **Not for this
thread** in the suggestion list stops them for one thread. When few suggestions get used,
esveo code offers them less often, and pauses them if almost none are used; turning **Prompt
suggestions** off and on again starts over.

## What it costs

Learning and suggestions run in the background on Claude Haiku 5.5 through the Claude provider,
so they count against your Claude subscription. **User insights model** switches to Haiku 4.5 or
Sonnet 5.5; Sonnet may read you more precisely but costs about 20 times as much per update.
Claude has to be turned on in **Settings** > **Providers**; a Claude instance you added yourself
is not used. Each call is logged with its tokens and the cost the same call would have on the
API. The settings section shows today, the last 7 days and the last 90 days, and the daily caps
that stop further calls until the next day.

## Seeing and changing what it learned

The settings section lists every learned trait with a confidence of low, medium or high. Edit a
trait to set it yourself: learning can then confirm or question it but not replace it. Delete a
trait to drop it, or **Undo last update** to go back one step.

Agents in your threads can read the medium and high confidence traits with the
`user_insights_read` tool, for example to match your style. They cannot change them.

## Where the data lives

Everything stays in the `user-insights` folder in the data directory of the server you are
connected to; **Open folder** opens it. It holds short, redacted excerpts of your messages
(secrets, tokens and email addresses are removed), the profile, the usage log and the outcome of
past suggestions. Nothing is synced to other servers or devices.

## Turning it off and deleting

Turning **User insights** off stops all learning and suggestions at once and keeps the folder.
**Reset learned data** forgets the profile, the collected messages and the suggestion history and
starts over; the usage log stays. **Delete everything** removes the whole folder and turns user
insights off. While user insights are off, **Delete everything** stays available as long as data
is stored.
