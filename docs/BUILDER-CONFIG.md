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

Use the form to edit options in BuildRequest.
The form does not edit all of the primary TOML.
The browser has no TOML parser or lossless document model.
Do not add an importer that drops unknown or advanced fields.

Before an editor can match the form, it must use the primary schema and validator.
It must retain unsupported values and comments. Users must approve trust in each remote.
Tests must cover rejected documents and round trips. Do not edit generated assets.

Before you add a repository or raw command, confirm trust in that entry.
An edit to the input clears this confirmation. Do not use shell syntax in repository identifiers.
The browser never imports raw commands from shared links.

The check for portable values does not allow headers for private keys or common credential assignments.
It also rejects URLs with user information, queries or fragments.
This check cannot detect every secret. Keep secrets out of configuration.

Share links do not contain commands or overrides for trusted connections.
The export of BuildRequest keeps the advanced options that the engine supports.
It refuses to export detected credentials. It does not delete them.
JSON is the transport for requests to the engine. It does not replace primary configuration.

The browser has no custom Flatpak remotes or complete TOML editor.
The app picker only records requests.

### Native catalog fixture fails before comparison

The native test uses a Node VM to evaluate `app.js`.
Its dependency list must include `setup-safety.js`.
Without this module, `updateShare` throws `TypeError: $(...).removeAttribute is not a function` in the minimal DOM fixture.
The fixture then exits before it compares catalog coverage.

The same fixture passed at `aa70af0` and failed at `551c3f0` and `5112421`.
Load the real module in `native/catalog_variants_test.go`; do not bypass the safety check or mock its result.
The Node test `tests/native-catalog-harness.test.cjs` runs this exact fixture without a GUI toolchain.
The Go test still compares the web output with the native loader.
