using System.Runtime.InteropServices;
using TunaOS.MediaWriter.Core.Helper;
using TunaOS.MediaWriter.Core.Protocol;
using Xunit;

namespace TunaOS.MediaWriter.Core.Tests;

public class CatalogViewTests
{
    [Fact]
    public void ShowsOnlyStandardGenericTargetsForThePlatformInFacetOrder()
    {
        var view = new CatalogView(Fixtures.Catalog(), "linux/amd64");
        Assert.Equal(["gnome", "kde", "xfce"], view.Desktops.Select(d => d.Id));
        Assert.Equal(["yellowfin", "bonito"], view.BasesFor("gnome").Select(b => b.Id));
        Assert.Equal(["skipjack"], view.BasesFor("xfce").Select(b => b.Id));
        Assert.Null(view.Resolve("gnome", "skipjack")); // only an "hwe" edition exists
    }

    [Fact]
    public void DefaultsFollowTheCatalogDefaultTarget()
    {
        var view = new CatalogView(Fixtures.Catalog(), "linux/amd64");
        Assert.Equal("gnome", view.DefaultDesktop);
        Assert.Equal("yellowfin", view.DefaultBaseFor("gnome"));
        Assert.Equal("yellowfin", view.DefaultBaseFor("kde"));
        Assert.Equal("skipjack", view.DefaultBaseFor("xfce")); // default base does not offer XFCE
    }

    [Fact]
    public void ArmHostsSeeArmTargets()
    {
        var view = new CatalogView(Fixtures.Catalog(), "linux/arm64");
        Assert.Equal(["gnome"], view.Desktops.Select(d => d.Id));
        Assert.Equal("linux/arm64", view.Platform);
    }

    [Fact]
    public void FallsBackToAmd64WhenThePlatformHasNoTargets()
    {
        var catalog = Fixtures.Catalog() with { Targets = Fixtures.Catalog().Targets.Where(t => t.Platform == "linux/amd64").ToList() };
        var view = new CatalogView(catalog, "linux/arm64");
        Assert.Equal("linux/amd64", view.Platform);
        Assert.NotEmpty(view.Desktops);
    }

    [Fact]
    public void HostPlatform()
    {
        Assert.Equal("linux/arm64", CatalogView.HostPlatform(Architecture.Arm64));
        Assert.Equal("linux/amd64", CatalogView.HostPlatform(Architecture.X64));
    }

    [Fact]
    public void Label()
    {
        var view = new CatalogView(Fixtures.Catalog(), "linux/amd64");
        Assert.Equal("KDE Plasma (Fedora 44)", view.LabelFor(view.Resolve("kde", "bonito")!));
    }
}

public class ProgressModelTests
{
    [Theory]
    [InlineData("download", 50, 100, "Downloading", 0.5)]
    [InlineData("write", 1, 4, "Writing", 0.25)]
    [InlineData("verify", 4, 4, "Verifying", 1.0)]
    [InlineData("unpack", 0, 10, "Building", 0.0)]
    [InlineData("unpack", 10, 10, "Building", 0.2)]
    [InlineData("erofs", 5, 10, "Building", 0.5)]
    [InlineData("iso", 10, 10, "Building", 1.0)]
    [InlineData("esp", 0, 0, "Building", 0.6)]
    public void MapsPhases(string phase, long current, long total, string label, double fraction)
    {
        var p = ProgressModel.For(phase, current, total);
        Assert.Equal(label, p.Label);
        Assert.Equal(fraction, p.Fraction!.Value, 3);
    }

    [Fact]
    public void UnknownTotalIsIndeterminate()
    {
        Assert.Null(ProgressModel.For("download", 5, 0).Fraction);
        Assert.Null(ProgressModel.For("something-new", 1, 2).Fraction);
    }

    [Fact]
    public void OverflowIsClamped() => Assert.Equal(1.0, ProgressModel.For("write", 9, 4).Fraction);
}

public class FormatTests
{
    [Theory]
    [InlineData(512, "512 bytes")]
    [InlineData(15376318464, "15.4 GB")]
    [InlineData(32_000_000_000, "32.0 GB")]
    [InlineData(1_500_000, "1.5 MB")]
    public void Size(long bytes, string expected)
    {
        using var _ = new InvariantCulture();
        Assert.Equal(expected, Format.Size(bytes));
    }

    [Fact]
    public void EraseTitleNamesTheDriveAndSize()
    {
        using var _ = new InvariantCulture();
        Assert.Equal("Erase SanDisk Ultra (15.4 GB)?", Strings.EraseTitle("SanDisk Ultra", 15376318464));
    }

    private sealed class InvariantCulture : IDisposable
    {
        private readonly System.Globalization.CultureInfo _saved = System.Globalization.CultureInfo.CurrentCulture;

        public InvariantCulture() => System.Globalization.CultureInfo.CurrentCulture = System.Globalization.CultureInfo.InvariantCulture;

        public void Dispose() => System.Globalization.CultureInfo.CurrentCulture = _saved;
    }
}

public class CommandLineTests
{
    [Theory]
    [InlineData("write", "write")]
    [InlineData("", "\"\"")]
    [InlineData(@"C:\Users\Jo Doe\a.iso", "\"C:\\Users\\Jo Doe\\a.iso\"")]
    [InlineData(@"C:\dir with space\", "\"C:\\dir with space\\\\\"")]
    [InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")]
    [InlineData(@"a\\""b", "\"a\\\\\\\\\\\"b\"")]
    [InlineData(@"\\.\PhysicalDrive2", @"\\.\PhysicalDrive2")]
    public void QuotesLikeCommandLineToArgvW(string arg, string expected) => Assert.Equal(expected, CommandLine.Quote(arg));

    [Fact]
    public void Joins() => Assert.Equal("write --iso \"C:\\a b.iso\"", CommandLine.Join(["write", "--iso", @"C:\a b.iso"]));
}

internal static class Fixtures
{
    public static Catalog Catalog() => new()
    {
        SnapshotDigest = "sha256:test",
        DefaultTarget = "yellowfin:gnome:linux/amd64",
        Desktops =
        [
            new() { Id = "gnome", Label = "GNOME", Description = "Clean." },
            new() { Id = "kde", Label = "KDE Plasma", Description = "Familiar." },
            new() { Id = "cosmic", Label = "COSMIC", Description = "Only hwe in this fixture." },
            new() { Id = "xfce", Label = "XFCE", Description = "Light." },
        ],
        Bases =
        [
            new() { Id = "yellowfin", Label = "AlmaLinux Kitten 10 (flagship)" },
            new() { Id = "bonito", Label = "Fedora 44" },
            new() { Id = "skipjack", Label = "CentOS Stream 10" },
        ],
        Targets =
        [
            T("bonito", "gnome"),
            T("yellowfin", "gnome"),
            T("yellowfin", "kde"),
            T("bonito", "kde"),
            T("skipjack", "xfce"),
            T("bonito", "cosmic", edition: "hwe"),
            T("skipjack", "gnome", edition: "hwe"),
            T("yellowfin", "gnome", platform: "linux/arm64"),
            T("yellowfin", "kde", hardware: "nvidia"),
        ],
    };

    private static CatalogTarget T(string b, string d, string platform = "linux/amd64", string edition = "standard", string hardware = "generic") => new()
    {
        Id = $"{b}:{d}:{platform}" + (edition == "standard" ? "" : ":" + edition) + (hardware == "generic" ? "" : ":" + hardware),
        Base = b,
        Desktop = d,
        Platform = platform,
        Edition = edition,
        Hardware = hardware,
        Image = $"ghcr.io/tuna-os/{b}:{d}",
        CompressedSize = 1_600_000_000,
    };
}
