# Multi-Boot Drive Management Workflows & CLI Parity

This document specifies the multi-boot drive management lifecycle capabilities exposed in iso-builder as defined in issue #2.

---

## 1. Feature Lifecycle Matrix

iso-builder surfaces tacklebox multi-boot drive lifecycle subcommands through a unified native GUI panel ("Manage this drive") and platform execution bridge (runTackleboxArgs):

- **Status** (`tacklebox status <drive>`): Identifies whether a drive is managed by tacklebox, listing installed OS environment IDs, boot targets, and allocated partition space.
- **Add** (`tacklebox add <recipe/img> <drive>`): Installs an additional OS environment onto an existing multi-boot drive alongside existing installations without reformatting.
- **Update** (`tacklebox update <recipe/img> <drive>` / `update_all`): Re-installs or upgrades an installed OS environment in place on the drive.
- **Remove** (`tacklebox remove <envID> <drive> --yes`): Uninstalls a specific OS environment, freeing its space without affecting other environments. Correctly surfaces tacklebox safety refusal when attempting to remove the last remaining environment.
- **Verify** (`tacklebox verify <drive>`): Performs integrity checks across GPT partition structures, systemd-boot entries, and environment payloads.

---

## 2. Cross-Platform Execution (runTackleboxArgs)

- **Signature Contract**: All three platform backends (`exec_linux.go`, `exec_darwin.go`, `exec_windows.go`) export the canonical `runTackleboxArgs` function:
  ```go
  func runTackleboxArgs(drivePath string, argsForDevice func(device string) []string, onLine func(string)) error
  ```
- **Linux Execution**: Direct execution via `sudo tacklebox <args...>`.
- **macOS / Windows Execution**: Drives attach into helper VMs / WSL2 instances to execute `tacklebox` natively.

---

## 3. UI Guardrails & Safety

- **Busy State (`busyGuard`)**: Disables all action buttons during in-flight operations to prevent concurrent drive mutations.
- **Destructive Confirmation**: Deletions and format operations prompt confirmation dialogs specifying the targeted drive path and environment ID.
