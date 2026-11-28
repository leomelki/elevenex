# Project settings

`ProjectSettingsComponent` renders the supplied reference's single-scroll sheet
with General, Repositories, Tasks, Agents and Git. Inputs:

- `project: ProjectSettingsProject`: the project face and name, plus `look`.
  Supply its stable `id` when reusing a sheet across projects so a project change
  also cancels folder requests; otherwise close/remount the sheet on navigation.
- `repos: readonly ProjectRepository[]`, optional `repoCount`: a bounded supplied
  repository window. Every repository needs a stable `id` and `path`; optional
  settings include `short`, `base`, `setup`, `check`, `tasks`, `sync`, `branches`.
- `open`, `section`, `openRepo`, `adding`, `addQuery`, `machine`, `since`, `id`.
  Supply distinct `id` values if multiple sheets are mounted in one document.
  Omitted `openRepo`/`adding` preserve local choices across section requests;
  explicit `null`/boolean values reset the requested state. Closing retains the
  visible repository/add row for its exit. Reopening applies requested values;
  a different stable project ID starts safely from that project's requests.
- `listFolders: FolderProvider`: the owner answers each path query with supplied
  folder entries, synchronously or asynchronously, and receives an `AbortSignal`.
- `preferences: ProjectPreferences` for task, agent and Git settings;
  `presets: readonly SettingChoice[]` for the two preset choices.
- `tasks`, `sessions`, `running`: counts for the nested delete confirmation.

Outputs are `closed`, `projectChanged`, `preferencesChanged`, `repoChanged`
(`{repo, patch}`), `repoAdded`, `repoRemoved`, `moreReposRequested`,
`archiveRequested`, and `deleteConfirmed`. Apply patches in the owning feature;
these components never save, enumerate the filesystem, prepare repositories,
spawn agents, or run Git. Empty preset choices remain disabled until supplied.

Repository edits stay in place. Tag starts as a field; commands use code wells;
branch choices come only from supplied branches. Remove and Delete each open a
nested confirmation and emit only the final intent. Cancel restores focus and
retains the parent sheet's recession. `DeleteProjectComponent` is separately
exported confirmation content for use inside `ModalLayerComponent`; it accepts
the project/counts/machine and emits `cancelled`, `archiveRequested`, and
`deleteConfirmed`.

Adding a repository opens its path field where the next row belongs. Arrow keys
choose an entry; Enter picks it or descends a supplied `dir` entry. The Add
button explicitly adds the chosen folder. Escape closes just the add row.
Changing query, closing or destroying the row aborts its previous request and
ignores late replies. Suggestions are capped at 50; branch choices and visible
repository rows at 100. Supply a bounded repository window and handle
`moreReposRequested` to replace/advance it when a project has more repositories.
No renderer scanning is performed.
The add-row's `active` input separates request/input activity from retained exit
content: inactive rows stay inert, keep their draft/results/loading presentation,
abort pending work and emit no intents. `ProjectSettings.open` supplies that
activity boundary while the sheet's portal finishes leaving.

The isolated `/project-settings` preview provides reference data and applies
all intents locally. Its `folderState` signal exercises supplied ready, loading,
empty and rejected listings. This fixture is outside the production entry.
The shared [sheet guide](../../ui/sheet/README.md) documents focus, responsive
navigation, background leases, interruption and reduced-motion behavior.

## Verification

The [14-state native capture](../../../../../../artifacts/desktop-capture/settings-final/report.json)
and [live reference capture](../../../../../../artifacts/desktop-capture/settings-reference-final/report.json)
both report `verified: true`, without renderer errors or warnings. Light/dark,
narrow sticky navigation, nested delete/removal, Escape/focus restoration, inline
edit cancellation, and ready/loading/empty/rejected supplied folder results were
inspected. The wide hero and every settings-row box match the live reference.
At 600px the sheet is `{24,52,552,560}`, the tabs `{24,90,552,47}`, and the
repository list `{48,217,504,527}` in both implementations. The independent
[final motion report](../../../../../../artifacts/desktop-capture/settings-final-motion-continuity/report.json)
verifies synchronized entry, numeric reversal continuity, reduced motion and
opener focus after the final shared-modal corrections. Thirteen focused Angular
tests cover the component boundaries, cancellation, context changes and cleanup.
