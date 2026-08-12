# ADR 0001: Scoping & Architecture Strategy for On-Drive Portable Writer Bundling (#4)

## Status
Deferred / Rescoped (Stretch Goal)

## Context
Issue #4 proposed copying portable builds of the **iso-builder** application (Linux, macOS, Windows) directly onto formatted multi-boot drives at write time (Ventoy-style), allowing users to manage their drives on any machine without pre-installing software, and potentially self-updating the drive-resident binaries.

## Architectural Tradeoffs & Findings

1. **Cross-Platform Compilation Overhead**:
   - Bundling portable app binaries for all three platforms requires cross-compiling Linux, macOS, and Windows executables at package build time for every release.
2. **Transient ESP Mount Semantics**:
   - The EFI System Partition (ESP) where on-drive binaries reside is mounted transiently during `tacklebox build / add / update` operations.
   - Writing files post-facto requires platform-specific mount bridges (block device mounts on Linux, `bootHelperVM` instances on macOS, WSL2 attaches on Windows), incurring significant time and resource costs for minor file operations.
3. **Partial Bundling Value Gap**:
   - A single-platform (e.g. Linux-only) binary does not satisfy the core cross-platform multi-machine management UX goal.

## Decision
- **Descope Self-Update & On-Drive Bundling for v1.0**:
  - Keep portable binary bundling deferred as a stretch capability until a unified release distribution channel and code-signing infrastructure are established.
- **Desktop Application as Primary Manager**:
  - Rely on desktop-installed `iso-builder` instances as the authoritative manager for connected `tacklebox` drives.
