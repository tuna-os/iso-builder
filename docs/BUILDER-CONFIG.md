# One frontend, deployment-owned configuration

`app/public/builder-config.json` is the portable input for this deployment.
The stock copy is an exact export of `[iso_builder]` in the primary `tunaos.toml`.
The receipt in `builder-config-source.json` records the immutable source commit
and SHA-256 hashes for configuration and flavor metadata. Do not edit these
exports or generated JavaScript by hand.

To import a reviewed primary export:

```sh
node scripts/sync-builder-config.cjs /path/to/iso-builder.config.json --source-commit COMMIT_SHA --flavors /path/to/iso-builder.flavors.json
node scripts/generate-builder-config.cjs
node scripts/generate-guided-catalog.cjs
node scripts/generate-experiences.cjs
node scripts/sync-builder-config.cjs --check
node scripts/generate-builder-config.cjs --check
node scripts/generate-guided-catalog.cjs --check
node scripts/generate-experiences.cjs --check
```

The importer compares bytes. CI checks the receipt without a network request.
The primary repository owns the schema, validator and export. The browser
validates the same contract before it starts. Invalid configuration shows an
error. It never selects a different brand as a fallback.

## Brand marks

`brand.logo_url` is a wordmark. The wordmark shows the brand name, so the header
shows the wordmark in place of the name text. The image alt text is the name.
A brand without `logo_url` gets a text header. `brand.favicon_url` is a small
square mark. For the TunaOS files and their licenses, see
`app/public/brand-marks-NOTICE.txt`.

## Catalog and questions

Version 2 supplies paths, facet labels, recommendations and a default leaf ID.
The catalog uses target keys from CatalogSnapshot v1.
The snapshot still owns references, availability and qualification. Flavor
metadata from the primary repository gives explicit desktop and edition IDs.
The generator reports obsolete, unavailable records that have no primary
metadata. An available record without metadata is an error.

The base-first and desktop-first paths use one set of leaves. A path changes
question order, not identity. A conflict needs an explicit choice to clear
related answers. An unavailable default selects no other image automatically.
The advanced form keeps the explicit version 1 adapter for old deployments.
Manual references are optional advanced inputs.

Brand configuration never grants relay access or build support. Preview leaves
have source evidence but no qualification. `preview_only: true` needs a visible
disclaimer and blocks inspection, ISO creation, DDI actions and autorun.
These guards also apply to direct calls from JavaScript.

## Experiences

`app/deployment-experiences.json` lists assets in this repository and a default ID.
Its generator validates each configuration and preview catalog. The browser
accepts only a known experience ID. It does not accept a configuration URL.

A switch starts a fresh page and drops other URL overrides. The switch is
unavailable during inspection, build or save. A fresh visit uses the default;
the browser does not store a different preference.

Other projects can supply the portable JSON directly. They do not need the
TunaOS repository or its build matrix. See the config-only
[examples](../examples/README.md) for the same frontend with alternate data.
The examples list sources for assets and limits for each license. Fonts are
local files with OFL notices; the browser makes no external request for fonts.

Flatpak search uses real Flathub metadata. Configuration does not add arbitrary
remotes. Transport trust and operation receipts remain engine concerns.

## Customization boundaries in the browser

The advanced form edits BuildRequest options, not the complete primary TOML.
It has no TOML parser or lossless document model. Do not add a partial TOML
importer that silently drops unknown or advanced fields. A future editor needs
the primary schema/validator, preservation of unsupported values and comments,
explicit trust decisions for remotes, and negative round-trip fixtures before
it can claim parity with the form. Generated deployment assets remain read-only.

Adding a repository or raw setup command requires acknowledgement for each
entry; changing the input resets it. Repository identifiers reject shell syntax.
Raw commands remain explicit advanced inputs, never imported from shared links.
The portable-value check rejects private-key headers, common credential
assignments and URLs containing user information, queries or fragments. This is
not a general secret detector; users must still keep secrets out of configuration.
Share links intentionally omit commands and trust-sensitive connection overrides.
BuildRequest export preserves supported advanced options and refuses detected
credentials rather than silently deleting them. It is engine transport, not a
new configuration source of truth. Custom Flatpak remotes and full TOML editing
remain unimplemented; the app picker still records requests only.

### Measured TOML editing blocker

The primary reference at `tuna-os/tunaOS` commit
`9e8398ce12ab3d515ae0e58eb5b71af6e2985ab5` parses TOML with vendored Tomli 2.3.2
(`scripts/lib/tunaos_config.py:parse`) and rejects unknown schema fields. Its
`iso_builder_config.py:project` derives desktop app defaults from
`flatpak_preinstall`; duplicating `default_flatpaks` in primary `[iso_builder]`
is an error. `[iso_builder]` describes deployment presentation and initial
selection, not an individual user's build request. A browser recipe cannot
be honestly round-tripped through that subsection by inventing keys for
packages, remotes or commands, or by treating an imported `preview_only=false`
as permission to build. No browser-compatible canonical TOML parser or full
per-build TOML contract is supplied in this repository. Until those contracts
exist, leave primary documents untouched and reject unsupported import instead
of reserializing or discarding unknown fields.

The existing `selection.facets.values.card` contract supports desktop previews.
The picker now renders a configured desktop card on its selected-image summary,
with an explicit distinction from qualification evidence. Stock TOML supplies
text descriptions but no desktop screenshots. The local primary checkout has
historical installer screenshots, not current desktop previews; they are not
misrepresented as desktop artwork. Supply reviewed screenshots through primary
TOML and its normal export workflow. Missing artwork is visibly identified;
UI tests use local synthetic fixtures rather than depend on external image hosts.

The local canonical validation check passed with Tomli 2.3.2 and schema 2.
Adding `iso_builder.packages = ["vim"]` failed with
`$: unknown keys ['packages']`; adding desktop `default_flatpaks` failed with
`desktops[0]: unknown keys ['default_flatpaks']`. The original TOML was only
read. Those failures are the reason the frontend does not reinterpret these
inputs as a supported round-trip format.

### Backend contract needed for application delivery

`app.js:build` currently sends requested `flatpaks`, `packages` and `extraRun`
options to the pinned engine. A request is not evidence that they were applied.
`build-result.js` validates observed source/overlay identity and output byte
counts; it does not return observed application inclusion. Before the UI can
promise installed apps, tacklebox and the primary configuration need a jointly
validated contract covering:

- Explicit application identity (remote, app ID, architecture, branch and pinned
  revision) and remote publisher trust; unsupported inputs fail before output.
- Whether the app is included in the live environment, installed system, or both,
  plus offline availability of required runtimes and content.
- Engine observations reporting what was actually applied, including failures,
  bound to the exact build result; never copy the request into those observations.
- Qualification that verifies the applications in the resulting installed system,
  separately from download, integrity and producer-authentication evidence.

The browser must keep displaying request-only status until that engine contract
and its validation exist. Custom remote configuration must not silently become a
shell command or expand registry/relay access.
