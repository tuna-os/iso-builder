# Multi-Boot Drive Management Workflows & CLI Parity

This document specifies how iso-builder manages the lifecycle of a multi-boot drive, as issue #2 defines.

---

## 1. Feature Lifecycle Matrix

iso-builder gives access to the drive subcommands of tacklebox through one panel in the native GUI ("Manage this drive"). A bridge for each platform (`runTackleboxArgs`) runs the subcommands:

- **Status** (`tacklebox status <drive>`): Shows if tacklebox manages a drive. It lists the IDs of each installed OS environment, the boot targets, and the allocated partition space.
- **Add** (`tacklebox add <recipe/img> <drive>`): Installs one more OS environment on a multi-boot drive, next to the current environments. It does not format the drive again.
- **Update** (`tacklebox update <recipe/img> <drive>` / `update_all`): Re-installs or upgrades an installed OS environment in place on the drive.
- **Remove** (`tacklebox remove <envID> <drive> --yes`): Uninstalls a specific OS environment and frees its space. Other environments do not change. If you try to remove the last environment, tacklebox refuses, and the GUI shows that refusal.
- **Verify** (`tacklebox verify <drive>`): Does integrity checks on the GPT partition structures, the systemd-boot entries, and the environment payloads.

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
- **Destructive Confirmation**: Before a delete or format operation, a dialog asks for confirmation. The dialog shows the drive path and the environment ID.
