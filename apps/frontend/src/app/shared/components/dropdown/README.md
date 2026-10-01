# Zard dropdown

Installed from the official [Zard registry](https://zardui.com/r/dropdown.json).
The source is vendored like the other components in this directory; no extra
runtime dependency is required.

Local adaptation: the service closes its overlay on destruction, allowing hosts
to provide it per component without leaving a menu behind.
Tab closes the menu and restores its origin before normal browser focus traversal.
