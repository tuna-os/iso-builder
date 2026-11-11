using System.Runtime.InteropServices;
using TunaOS.MediaWriter.Core.Protocol;

namespace TunaOS.MediaWriter.Core;

/// <summary>
/// What step 1 shows: standard/generic targets for one platform, desktops and bases
/// in the catalog's (builder-config facet) order.
/// </summary>
public sealed class CatalogView
{
    public const string StandardEdition = "standard";
    public const string GenericHardware = "generic";

    private readonly Catalog _catalog;
    private readonly List<CatalogTarget> _targets;

    public CatalogView(Catalog catalog, string platform)
    {
        _catalog = catalog;
        _targets = catalog.Targets.Where(t => t.Platform == platform && IsDefaultKind(t)).ToList();
        if (_targets.Count == 0 && platform != "linux/amd64")
        {
            // e.g. Windows on Arm while no arm64 images are published: the stick is
            // usually meant for an ordinary PC anyway.
            platform = "linux/amd64";
            _targets = catalog.Targets.Where(t => t.Platform == platform && IsDefaultKind(t)).ToList();
        }

        Platform = platform;
        Desktops = catalog.Desktops.Where(d => _targets.Any(t => t.Desktop == d.Id)).ToList();
    }

    public string Platform { get; }

    public IReadOnlyList<CatalogDesktop> Desktops { get; }

    public static string HostPlatform(Architecture arch) =>
        arch == Architecture.Arm64 ? "linux/arm64" : "linux/amd64";

    public IReadOnlyList<CatalogBase> BasesFor(string desktopId) =>
        _catalog.Bases.Where(b => _targets.Any(t => t.Desktop == desktopId && t.Base == b.Id)).ToList();

    public string? DefaultDesktop
    {
        get
        {
            var preferred = _catalog.Targets.FirstOrDefault(t => t.Id == _catalog.DefaultTarget)?.Desktop;
            return Desktops.Any(d => d.Id == preferred) ? preferred : Desktops.FirstOrDefault()?.Id;
        }
    }

    /// <summary>The catalog's default base when it offers this desktop, else the first base that does.</summary>
    public string? DefaultBaseFor(string desktopId)
    {
        var bases = BasesFor(desktopId);
        var preferred = _catalog.Targets.FirstOrDefault(t => t.Id == _catalog.DefaultTarget)?.Base;
        return bases.Any(b => b.Id == preferred) ? preferred : bases.FirstOrDefault()?.Id;
    }

    public CatalogTarget? Resolve(string? desktopId, string? baseId) =>
        _targets.FirstOrDefault(t => t.Desktop == desktopId && t.Base == baseId);

    public string LabelFor(CatalogTarget target)
    {
        var desktop = _catalog.Desktops.FirstOrDefault(d => d.Id == target.Desktop)?.Label ?? target.Desktop;
        var baseLabel = _catalog.Bases.FirstOrDefault(b => b.Id == target.Base)?.Label ?? target.Base;
        return $"{desktop} ({baseLabel})";
    }

    private static bool IsDefaultKind(CatalogTarget t) =>
        (t.Edition is "" or StandardEdition) && (t.Hardware is "" or GenericHardware);
}
