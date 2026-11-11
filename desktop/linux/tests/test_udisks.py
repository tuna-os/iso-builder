"""udisks2 lookups and the unmount/lock plan, against an in-memory object manager."""

from gi.repository import GLib

from tunaos_media_writer import udisks
from tunaos_media_writer.udisks import UDisks

ROOT = "/org/freedesktop/UDisks2"


def bytestring(text):
    return GLib.Variant("ay", text.encode() + b"\0")


def bytestrings(*texts):
    return GLib.Variant("aay", [t.encode() + b"\0" for t in texts])


class Iface:
    def __init__(self, props):
        self.props = props

    def get_cached_property(self, name):
        return self.props.get(name)


class Obj:
    def __init__(self, path, **ifaces):
        self.path = path
        self.ifaces = {f"org.freedesktop.UDisks2.{k}": Iface(v) for k, v in ifaces.items()}

    def get_object_path(self):
        return self.path

    def get_interface(self, name):
        return self.ifaces.get(name)


class Manager:
    def __init__(self, objects):
        self.objects = objects

    def get_connection(self):
        return None

    def get_objects(self):
        return list(self.objects)

    def get_object(self, path):
        return next((o for o in self.objects if o.path == path), None)


def block(name, drive="/", hint_system=False, mounts=(), table=None, backing="/", cleartext=None):
    ifaces = {
        "Block": {
            "Device": bytestring(f"/dev/{name}"),
            "PreferredDevice": bytestring(f"/dev/{name}"),
            "Symlinks": bytestrings(f"/dev/disk/by-id/usb-{name}"),
            "Drive": GLib.Variant("o", drive),
            "HintSystem": GLib.Variant("b", hint_system),
            "CryptoBackingDevice": GLib.Variant("o", backing),
        }
    }
    if table:
        ifaces["Partition"] = {"Table": GLib.Variant("o", table)}
    if mounts is not None:
        ifaces["Filesystem"] = {"MountPoints": bytestrings(*mounts)}
    if cleartext:
        ifaces["Encrypted"] = {"CleartextDevice": GLib.Variant("o", cleartext)}
    return Obj(f"{ROOT}/block_devices/{name}", **ifaces)


def stick():
    drive = Obj(f"{ROOT}/drives/Kingston", Drive={"Vendor": GLib.Variant("s", "Kingston "),
                                                  "Model": GLib.Variant("s", "DataTraveler")})
    disk = f"{ROOT}/block_devices/sdb"
    return [
        drive,
        block("sdb", drive.path, mounts=None),
        block("sdb1", drive.path, mounts=["/run/media/u/STICK"], table=disk),
        block("sdb2", drive.path, mounts=None, table=disk, cleartext=f"{ROOT}/block_devices/dm_2d0"),
        block("dm_2d0", mounts=["/run/media/u/secret"], backing=f"{ROOT}/block_devices/sdb2"),
        block("sdb3", drive.path, mounts=[], table=disk),
        block("nvme0n1", f"{ROOT}/drives/Samsung", hint_system=True, mounts=None),
        block("nvme0n1p2", f"{ROOT}/drives/Samsung", hint_system=True, mounts=["/"],
              table=f"{ROOT}/block_devices/nvme0n1"),
    ]


def test_block_lookup_by_device_and_symlink():
    client = UDisks(Manager(stick()))
    info = client.block_for_device("/dev/sdb")
    assert info.object_path.endswith("/sdb") and not info.hint_system
    assert info.display_name == "Kingston DataTraveler"
    assert client.block_for_device("/dev/disk/by-id/usb-sdb").object_path == info.object_path
    assert client.block_for_device("/dev/nvme0n1").hint_system
    assert client.block_for_device("/dev/sdz") is None


def test_release_plan_unmounts_then_locks_only_that_disk():
    plan = UDisks(Manager(stick()))._plan_release(f"{ROOT}/block_devices/sdb")
    assert plan == [
        (f"{ROOT}/block_devices/sdb1", udisks.FILESYSTEM),
        (f"{ROOT}/block_devices/dm_2d0", udisks.FILESYSTEM),
        (f"{ROOT}/block_devices/sdb2", udisks.ENCRYPTED),
    ]
