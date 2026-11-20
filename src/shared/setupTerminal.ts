// The one terminal session behind the setup wizard / Settings "Terminal" box (install and sign in to tools).
// It is a plain shell session that no board node owns, so session listings leave it out (`Sessions.list`).

/** Session id of that terminal (matches SAFE_NODE_ID); one per server, re-attached on reopen. */
export const SETUP_TERMINAL_ID = 'setup-terminal'
