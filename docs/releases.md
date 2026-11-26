# Releases and versioning

This document defines how uburoom versions and releases are **intended** to work. It is a policy, not evidence that release automation, build metadata, or distribution tooling already exists. Implement those mechanisms in a separately authorized task. Current release readiness and verification evidence live in [testing](testing.md) and the [roadmap](../ROADMAP.md).

## Authority and version identity

- `package.json` is the source of truth for the **application** version. Keep the root `package-lock.json` in sync when that version changes. Diagnostic output, UI, startup messages, and distribution metadata should derive their version from this value, not hardcoded copies.
- A development build must also identify the exact Git commit when available (for example, `0.6.0-dev (gabcdef0)`). If it was built from modified working files, identify it as dirty. In distributed artifacts without `.git`, include the built commit identifier in build metadata instead. This is an implementation requirement, not a claim that it is already supported.
- An untagged build is not a published release, even if its package version has no prerelease suffix. Release tags use `vMAJOR.MINOR.PATCH` (or `vMAJOR.MINOR.PATCH-rc.N` for explicitly published release candidates) and must point to the exact tested source revision.
- Application versions are **not** database schema versions, configuration format versions, or wire-protocol versions. Maintain and validate those contracts independently; a version number by itself does not guarantee upgrade compatibility.
- Ordinary commits, merges, agent tasks, and deployment to a private server **never** bump the application version automatically. Only the owner can authorize a version bump, release candidate, tag, or publication. A requested documentation change does not authorize publishing a release.

## Choosing a version

Use [Semantic Versioning](https://semver.org/), with explicit pre-1.0 conventions:

| Change | Version rule |
| --- | --- |
| Ordinary development, tests, refactors, or docs | No automatic application version bump; identify the commit |
| Bug-fix release with no intended compatibility break | Increment PATCH (`0.6.0` → `0.6.1`) |
| Feature release before 1.0 | Increment MINOR (`0.6.0` → `0.7.0`) |
| Intentional breaking change before 1.0 | Increment MINOR, document impact and migration/restore path |
| Breaking change at or after 1.0 | Increment MAJOR |
| Backward-compatible feature at or after 1.0 | Increment MINOR |

Pre-1.0 signals that compatibility is still being established, **not** that state loss is acceptable. Never hide an incompatible data/configuration change in a patch release. Reserve `1.0.0` for an explicitly accepted self-hosted support and upgrade contract, not a commit count or elapsed date.

During preparation, an owner may choose `X.Y.Z-dev` as the next development version and `X.Y.Z-rc.1`, `rc.2`, etc. for frozen release candidates. The next `-dev` version is a planning choice, not something agents calculate and write automatically. The Git commit distinguishes development builds sharing the same package version. Prereleases are not stable releases.

## Release procedure

1. **Authorize and scope.** The owner chooses the intended version, release commit, feature freeze, supported environments, and whether any release candidates are needed. Do not infer approval from completed features or a green test run.
2. **Prepare the version and notes.** Update `package.json` and `package-lock.json` together. Prepare release notes that distinguish added features, fixes, known limitations, breaking behavior, schema/config/protocol changes, and operator action required. Avoid claiming a feature has live verification just because it has fixture tests.
3. **Meet the release gates.** Review [ROADMAP.md](../ROADMAP.md) and [testing.md](testing.md). Run the required automated suites and relevant real provider/device, installation, security/privacy, license/provenance, packaging, and human-acceptance checks. Record exact revision and results. Outstanding gates mean it remains a development build or candidate, not a stable published release.
4. **Validate upgrades and rollback.** Follow [upgrading.md](upgrading.md). Test with matched code, config, database/WAL state, TLS materials, and the **original credential encryption key**. Preserve account UUIDs and authenticated encrypted state. Do not assume private pre-release layouts have supported migrations; a published release changing a supported baseline needs an explicit reviewed forward migration and rollback guidance.
5. **Build and inspect artifacts.** Ensure ZIPs, containers, and other supported distribution paths identify the same version and exact commit. Check that archives exclude `personal/`, credentials, private configuration/state, and other secrets. Only distribute a platform/package that was actually verified. Keep tags immutable; do not move them to later commits.
6. **Publish only on approval.** After the owner authorizes publication, create the matching Git tag and GitHub Release with the reviewed notes, artifacts, and upgrade warnings. An automated workflow, if later implemented, must not silently publish on routine merges or pushes.

For a patch release, apply the same release and upgrade discipline with a smaller, risk-based test scope; do not assume a patch is harmless to an operator's stored state.

## Windows installer and SignPath Foundation OSS signing

The draft release workflow (`.github/workflows/release.yml`) builds three Windows release assets on GitHub-hosted `windows-latest` runners:

1. `uburoom-<slot>-setup.exe` — per-user Inno Setup installer compiled from `installer/uburoom.iss` (installs to `%LOCALAPPDATA%\Programs\uburoom` with `PrivilegesRequired=lowest`, preserves `config\` and `%LOCALAPPDATA%\uburoom\credentials.key`).
2. `uburoom-<slot>-win-x64.zip` — portable standalone bundle containing `uburoom-tray.exe`, `start-uburoom.bat`, `doctor.bat`, and the versioned slot (`versions/<slot>/`).
3. `uburoom-gpl-source-<slot>.zip` — GPLv3 Corresponding Source archive for uburoom and its bundled Node.js/FFmpeg binaries.

Local builds can also compile the installer when Inno Setup 6 (`ISCC.exe`) is installed:

```powershell
node scripts/package-standalone.js --installer
```

### Enabling SignPath Foundation OSS signing

Release binaries are currently unsigned until SignPath Foundation OSS onboarding is approved. Do not add unconfigured signing steps to `.github/workflows/release.yml` before approval, as missing secrets or unapproved projects will fail release builds.

Once the [SignPath Foundation](https://signpath.org/) approves uburoom:

1. **Install the SignPath GitHub App** on the repository so SignPath can verify workflow origin and confirm all jobs ran on GitHub-hosted runners.
2. **Create SignPath artifact configurations** in the SignPath organization for:
   - First-party tray binary (`uburoom-tray.exe`, PE Authenticode signing).
   - Inno Setup installer (`uburoom-*-setup.exe`, Inno Setup artifact configuration so both the outer installer and embedded uninstaller are signed).
   - Do **not** re-sign bundled third-party runtimes (`node.exe`, `ffmpeg.exe`, `ffprobe.exe`).
3. **Add repository secrets and variables** (never store private keys or PFX certificates in GitHub Secrets):
   - Secret: `SIGNPATH_API_TOKEN`
   - Variables (or explicit slugs): `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` (e.g. `uburoom`), `SIGNPATH_SIGNING_POLICY_SLUG` (e.g. `release-signing`).
4. **Plug in the two marked hooks in `.github/workflows/release.yml`:**
   - **Stage 1 (before `Compile Windows installer`):** upload `uburoom-tray.exe` from `steps.artifacts.outputs.verify_dir` with `actions/upload-artifact@v4`, submit it to `signpath/github-action-submit-signing-request@v3`, replace `uburoom-tray.exe` in `verify_dir` with the signed binary, and re-zip `verify_dir` into `bundle_path` so both the portable ZIP and installer ship the signed tray executable.
   - **Stage 2 (after `Compile Windows installer`, before `Create Draft GitHub Release`):** upload `steps.artifacts.outputs.installer_path` and submit it with the Inno Setup artifact configuration, replacing `installer_path` with the signed output:

```yaml
- name: Upload unsigned installer for SignPath
  id: upload-unsigned-installer
  uses: actions/upload-artifact@v4
  with:
    name: uburoom-unsigned-installer
    path: ${{ steps.artifacts.outputs.installer_path }}
    retention-days: 1

- name: Sign installer with SignPath
  uses: signpath/github-action-submit-signing-request@v3
  with:
    api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
    organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
    project-slug: ${{ vars.SIGNPATH_PROJECT_SLUG }}
    signing-policy-slug: ${{ vars.SIGNPATH_SIGNING_POLICY_SLUG }}
    artifact-configuration-slug: inno-setup-installer
    github-artifact-id: ${{ steps.upload-unsigned-installer.outputs.artifact-id }}
    wait-for-completion: true
    output-artifact-directory: ${{ steps.artifacts.outputs.upload_dir }}
```

5. **Verify signatures** before publishing the draft release (`Get-AuthenticodeSignature` on both `uburoom-<slot>-setup.exe` and the installed `uburoom-tray.exe`).
