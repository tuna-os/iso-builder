"""Every user-visible string, in one place for later localization.

Keep jargon off the main path: no "OCI", "bootc", "EROFS", "layer".
"""

import gettext

_ = gettext.translation("tunaos-media-writer", fallback=True).gettext

APP_NAME = _("TunaOS Media Writer")
INSTALL_DOCS_URL = "https://tunaos.org/docs"

# Step 1: choose
CATALOG_LOADING = _("Loading the list of systems…")
CHOOSE_TITLE = _("Choose your desktop")
CHOOSE_DESCRIPTION = _("Pick how your computer should look and feel.")
BASE_GROUP = _("System")
BASE_ROW = _("Based on")
CONTINUE = _("Continue")
OPEN_REQUEST = _("Open build request…")
OPEN_REQUEST_TITLE = _("Open a build request from iso.tunaos.org")
SOURCE_LABEL = _("{desktop} on {base}")
REQUEST_FILTER = _("Build requests")
REQUEST_UNREADABLE = _("That file is not a build request from iso.tunaos.org.")
NO_TARGETS_FOR_HOST = _("No systems are available for this computer.")

# Step 2: destination
DESTINATION_TITLE = _("Choose a USB stick")
DRIVES_GROUP = _("USB sticks")
DRIVES_GROUP_DESCRIPTION = _("Everything on the USB stick you pick will be erased.")
NO_DRIVES_TITLE = _("Plug in a USB stick")
NO_DRIVES_SUBTITLE = _("It will show up here. 8 GB or larger works best.")
SAVE_GROUP = _("Or")
SAVE_ISO = _("Save ISO file only…")
SAVE_ISO_SUBTITLE = _("Write it to a USB stick later with another tool")
SAVE_DIALOG_TITLE = _("Save ISO file")
ERASE_HEADING = _("Erase {name} ({size})?")
ERASE_BODY = _("Everything on it will be deleted.")
ERASE = _("Erase")
CANCEL = _("Cancel")
DRIVE_FALLBACK_NAME = _("USB drive")
DRIVE_BUS = {
    "usb": _("USB"),
    "sd": _("SD card"),
    "other": _("Drive"),
}

# Step 3: progress
STAGE_PREPARING = _("Getting ready")
STAGE_DOWNLOADING = _("Downloading")
STAGE_BUILDING = _("Building")
STAGE_WAITING_PERMISSION = _("Waiting for permission")
STAGE_WRITING = _("Writing")
STAGE_VERIFYING = _("Verifying")
STAGE_CANCELLING = _("Cancelling")
PROGRESS_KEEP_PLUGGED = _("Keep the USB stick plugged in until this finishes.")
PROGRESS_SAVE = _("Saving to {path}")
PROGRESS_PERCENT = _("{percent}%")
PROGRESS_BYTES = _("{current} of {total}")
CANCELLED = _("Cancelled")

# Step 4: done
DONE_DRIVE_TITLE = _("Your USB stick is ready")
DONE_DRIVE_BODY = _("Restart your computer and boot from it.")
DONE_FILE_TITLE = _("Your ISO file is saved")
DONE_FILE_BODY = _("Saved to {path}")
SHOW_IN_FILES = _("Show in Files")
INSTALL_DOCS = _("How to install TunaOS")
START_OVER = _("Make another")

# Errors
ERROR_TITLE = {
    "network": _("Could not download TunaOS"),
    "storage": _("Not enough space"),
    "permission": _("Permission was not granted"),
    "device-changed": _("The USB stick changed"),
    "verify-mismatch": _("The USB stick did not verify"),
    "engine": _("Building TunaOS failed"),
    "usage": _("Something went wrong"),
}
ERROR_TITLE_FALLBACK = _("Something went wrong")
ERROR_HELPER_MISSING = _("The TunaOS Media Writer installation is incomplete. Reinstall it and try again.")
ERROR_HELPER_CRASHED = _("The writer stopped unexpectedly.")
ERROR_UNMOUNT = _("The USB stick is in use. Close any files open on it and try again.")
ERROR_DRIVE_GONE = _("The USB stick was removed. Plug it back in and try again.")
ERROR_OPEN_DEVICE = _("Could not open the USB stick for writing.")
TRY_AGAIN = _("Try again")
SHOW_DETAILS = _("Show details")
ERROR_PERMISSION = _("Writing to the USB stick needs your permission. Try again and confirm when asked.")
DETAILS_TITLE = _("Details")
COPY = _("Copy")
COPIED = _("Copied")
ABOUT = _("About TunaOS Media Writer")
