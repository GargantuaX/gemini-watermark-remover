# Release artifacts

This checkout retains the archives for the version in `package.json`, plus historical checksums and quality evidence. Older ZIP/TGZ files are no longer duplicated in the current source tree.

Published versions remain available from [GitHub Releases](https://github.com/GargantuaX/gemini-watermark-remover/releases) and the npm registry. Historical Git tags are unchanged. This cleanup does not replace published artifacts or rewrite Git history.

The publishing workflow still requires the current version's committed TGZ and verifies it against its tag. Keep that archive, both current extension variants and their checksum files when preparing a release. After the next version is published, older archives can be removed from the current tree while retaining their checksums and release evidence.

Local cleanup backups are stored under the ignored `.artifacts/` directory. They are not part of source distribution. Removing files from the current tree reduces checkout contents, but does not reduce the size of existing Git history.
