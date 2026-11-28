# HostField

Adding a server. Hosts from `~/.ssh/config` come first and filter as you type; `user@host:port` works too. Once a host is picked, its user, port and how it signs in show under the field.

**Provide:** `query`, `hosts` (`[{ name, detail }]`, from `~/.ssh/config`), `picked` (`{ name, user, port, auth, fromConfig }`).

- Do reuse what's there: the SSH config, the agent's keys, ProxyJump. A password works too, once, to add a key.
- Do install without root: the engine goes into `~/.elevenex` and runs as the user.
