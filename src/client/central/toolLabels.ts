// Plain title and sentence per Central tool for the Abilities tab. The server summaries stay as they are:
// they are written for the model (PageRank, hash-verified, asOf). An unknown name falls back to its summary.

export interface ToolLabel { title: string; text: string }

export const TOOL_LABELS: Readonly<Record<string, ToolLabel>> = {
  'node.list': { title: 'List nodes', text: 'Lists the terminals, agents, browsers and files on a project canvas.' },
  'node.inspect': { title: 'Read a node', text: 'Reads what a terminal or Claude session on the canvas shows, its status and model.' },
  'canvas.open': { title: 'Open nodes', text: 'Opens new terminals, Claude sessions or a browser on a project canvas.' },
  'canvas.close': { title: 'Close nodes', text: 'Closes nodes on a project canvas after you approve; you can reopen them.' },
  'canvas.view': { title: 'See current view', text: 'Shows which project workspace you are viewing and its nodes.' },
  'canvas.show': { title: 'Show workspace', text: 'Switches your canvas to a project workspace and centres a node.' },
  'canvas.screenshot': { title: 'Take screenshot', text: 'Captures what you see in the webterm window.' },
  'project.brief': { title: 'Project summary', text: 'Gives a short status of a project and what to do next.' },
  'project.discover': { title: 'Find new folders', text: 'Finds folders that are not a project yet.' },
  'project.list': { title: 'List projects', text: 'Lists your projects with their tasks and approvals.' },
  'project.read': { title: 'Read a project', text: 'Reads a project’s branch, top files, README and CLAUDE.md.' },
  'repo.map': { title: 'Map the code', text: 'Shows the most important files of a project and what they define.' },
  'agent.close': { title: 'Stop a worker', text: 'Stops a worker, gently or by force.' },
  'agent.kinds': { title: 'List worker types', text: 'Lists the kinds of workers Central can start.' },
  'agent.list': { title: 'List workers', text: 'Lists the workers in a project and what they are doing.' },
  'agent.prompt': { title: 'Message a worker', text: 'Sends a message to a running worker.' },
  'agent.read': { title: 'Read worker output', text: 'Reads the last lines a worker printed.' },
  'agent.relay': { title: 'Pass on a message', text: 'Hands a message to a worker once it is free.' },
  'agent.spawn': { title: 'Start a worker', text: 'Starts a new worker or reviewer for a project.' },
  'agent.status': { title: 'Check a worker', text: 'Shows one worker’s state and when it started or ended.' },
  'goal.propose': { title: 'Suggest a goal', text: 'Suggests a project goal with what success looks like and a budget.' },
  'plan.propose': { title: 'Suggest a plan', text: 'Suggests a plan as a list of steps for you to approve.' },
  'run.result': { title: 'Check a result', text: 'Shows how a task’s latest run went.' },
  'task.assign': { title: 'Create a task', text: 'Turns a plan step into a task. Does not run it.' },
  'task.run': { title: 'Run a task', text: 'Has a worker do a task in its own copy of the code, then checks the result.' },
  'task.status': { title: 'Check tasks', text: 'Shows how a project’s tasks are going.' },
  'blackboard.propose': { title: 'Suggest a shared note', text: 'Suggests a change to the shared notes; you confirm it.' },
  'blackboard.read': { title: 'Read shared notes', text: 'Reads the shared notes: goals and decisions.' },
  'kb.map': { title: 'Folder overview', text: 'Shows a project’s folders, the most used first.' },
  'kb.search': { title: 'Search docs and code', text: 'Searches a project’s docs and code names.' },
  'memory.get': { title: 'Recall one item', text: 'Reads one thing Central remembered.' },
  'memory.remember': { title: 'Note something', text: 'Notes something for later; you decide if it becomes a fact.' },
  'memory.remember_user': { title: 'Remember about you', text: 'Saves something you said about yourself, in your own words.' },
  'memory.search': { title: 'Search memory', text: 'Searches what Central remembers.' },
  'browser_act': { title: 'Use the browser', text: 'Opens pages, clicks and types in a browser node.' },
  'browser_status': { title: 'Check browsers', text: 'Lists the browser nodes of a project and the sites you are signed in to.' },
  'skill.list': { title: 'List skills', text: 'Lists the skills Central has.' },
  'skill.load': { title: 'Use a skill', text: 'Loads an approved skill’s instructions.' },
  'skill.propose': { title: 'Suggest a skill', text: 'Writes a new skill for you to review. It is not used until you approve it.' },
  'channel.bot.propose': { title: 'Connect a Telegram bot', text: 'Adds a Telegram bot. Needs your approval and typed confirm.' },
  'approval.request': { title: 'Ask for approval', text: 'Asks you to approve something. Never decides by itself.' },
  'cap.describe': { title: 'Explain a tool', text: 'Explains how one of its own tools is used.' },
  'cap.search': { title: 'Find a tool', text: 'Looks up its own tools by keyword.' },
}

/** Plain title and sentence of a tool; an unknown tool shows its name and server summary. */
export const toolLabel = (name: string, summary: string): ToolLabel => TOOL_LABELS[name] ?? { title: name, text: summary }
