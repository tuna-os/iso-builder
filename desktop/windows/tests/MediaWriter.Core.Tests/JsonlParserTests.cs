using System.Text;
using TunaOS.MediaWriter.Core.Protocol;
using Xunit;

namespace TunaOS.MediaWriter.Core.Tests;

public class JsonlParserTests
{
    [Fact]
    public void Progress()
    {
        var ev = JsonlParser.ParseLine(
            """{"event":"progress","phase":"unpack","current":3,"total":12,"unit":"layers","message":"Unpacking layer 3/12"}""");
        Assert.Equal(new ProgressEvent("unpack", 3, 12, "layers", "Unpacking layer 3/12"), ev);
    }

    [Fact]
    public void ProgressToleratesMissingAndFractionalNumbers()
    {
        var ev = Assert.IsType<ProgressEvent>(JsonlParser.ParseLine("""{"event":"progress","phase":"iso","current":5.0}"""));
        Assert.Equal(5, ev.Current);
        Assert.Equal(0, ev.Total);
        Assert.Equal("", ev.Unit);
    }

    [Fact]
    public void LogAndError()
    {
        Assert.Equal(new LogEvent("warn", "offline"), JsonlParser.ParseLine("""{"event":"log","level":"warn","message":"offline"}"""));
        Assert.Equal(
            new ErrorEvent("storage", "25 GB needed"),
            JsonlParser.ParseLine("""{"event":"error","kind":"storage","message":"25 GB needed"}"""));
    }

    [Fact]
    public void Version()
    {
        Assert.Equal(
            new VersionEvent("1.2.3", "v0.0.0-2026", 1),
            JsonlParser.ParseLine("""{"event":"version","helper":"1.2.3","engine":"v0.0.0-2026","protocol":1}"""));
    }

    [Fact]
    public void Catalog()
    {
        var ev = Assert.IsType<CatalogEvent>(JsonlParser.ParseLine(
            """
            {"event":"catalog","snapshotDigest":"sha256:abc","defaultTarget":"yellowfin:gnome:linux/amd64",
             "desktops":[{"id":"gnome","label":"GNOME","description":"Clean."}],
             "bases":[{"id":"yellowfin","label":"AlmaLinux Kitten 10 (flagship)"}],
             "targets":[{"id":"yellowfin:gnome:linux/amd64","base":"yellowfin","desktop":"gnome","platform":"linux/amd64",
                         "edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/yellowfin:gnome",
                         "compressedSize":1625549436,"browserQualified":false,"futureField":{"x":1}}]}
            """.ReplaceLineEndings(" ")));
        var c = ev.Catalog;
        Assert.Equal("sha256:abc", c.SnapshotDigest);
        Assert.Equal("yellowfin:gnome:linux/amd64", c.DefaultTarget);
        Assert.Equal("Clean.", Assert.Single(c.Desktops).Description);
        Assert.Equal("AlmaLinux Kitten 10 (flagship)", Assert.Single(c.Bases).Label);
        var t = Assert.Single(c.Targets);
        Assert.Equal(1625549436, t.CompressedSize);
        Assert.Equal("ghcr.io/tuna-os/yellowfin:gnome", t.Image);
        Assert.False(t.BrowserQualified);
    }

    [Fact]
    public void Drives()
    {
        var ev = Assert.IsType<DrivesEvent>(JsonlParser.ParseLine(
            """{"event":"drives","drives":[{"id":"disk2:SER","path":"\\\\.\\PhysicalDrive2","name":"SanDisk Ultra","sizeBytes":15376318464,"bus":"usb","removable":true,"mounted":["E:\\"],"systemDisk":false}]}"""));
        var d = Assert.Single(ev.Drives);
        Assert.Equal(@"\\.\PhysicalDrive2", d.Path);
        Assert.Equal(15376318464, d.SizeBytes);
        Assert.Equal(@"E:\", Assert.Single(d.Mounted));
        Assert.True(d.Removable);
    }

    [Fact]
    public void EmptyDrives() =>
        Assert.Empty(Assert.IsType<DrivesEvent>(JsonlParser.ParseLine("""{"event":"drives","drives":[]}""")).Drives);

    [Fact]
    public void GoNilSlicesBecomeEmptyLists()
    {
        Assert.Empty(Assert.IsType<DrivesEvent>(JsonlParser.ParseLine("""{"event":"drives","drives":null}""")).Drives);
        var drive = Assert.Single(Assert.IsType<DrivesEvent>(
            JsonlParser.ParseLine("""{"event":"drives","drives":[{"id":"a","mounted":null}]}""")).Drives);
        Assert.Empty(drive.Mounted);
        var catalog = Assert.IsType<CatalogEvent>(
            JsonlParser.ParseLine("""{"event":"catalog","desktops":null,"bases":null,"targets":null}""")).Catalog;
        Assert.Empty(catalog.Desktops);
        Assert.Empty(catalog.Bases);
        Assert.Empty(catalog.Targets);
    }

    [Fact]
    public void DoneIsDisambiguatedByDevice()
    {
        Assert.Equal(
            new BuildDoneEvent(@"C:\out.iso", 42, "ab"),
            JsonlParser.ParseLine("""{"event":"done","path":"C:\\out.iso","bytes":42,"sha256":"ab"}"""));
        Assert.Equal(
            new WriteDoneEvent("disk2:SER", 42, true),
            JsonlParser.ParseLine("""{"event":"done","device":"disk2:SER","bytes":42,"verified":true}"""));
    }

    [Fact]
    public void UnknownEventIsKept()
    {
        var ev = Assert.IsType<UnknownEvent>(JsonlParser.ParseLine("""{"event":"heartbeat"}"""));
        Assert.Equal("heartbeat", ev.Name);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\r")]
    public void BlankLinesAreSkipped(string line) => Assert.Null(JsonlParser.ParseLine(line));

    [Theory]
    [InlineData("not json")]
    [InlineData("[1,2]")]
    [InlineData("""{"phase":"iso"}""")]
    [InlineData("""{"event":7}""")]
    [InlineData("""{"event":"catalog","targets":"oops"}""")]
    [InlineData("""{"event":"progress",""")]
    public void MalformedLinesNeverThrow(string line) => Assert.IsType<MalformedLine>(JsonlParser.ParseLine(line));

    [Fact]
    public void LeadingBomIsIgnored() =>
        Assert.IsType<LogEvent>(JsonlParser.ParseLine("\uFEFF{\"event\":\"log\",\"level\":\"info\",\"message\":\"x\"}"));
}

public class JsonlLineBufferTests
{
    [Fact]
    public void JoinsLinesAcrossChunks()
    {
        var buffer = new JsonlLineBuffer();
        Assert.Empty(buffer.Append("{\"event\":"u8));
        Assert.Equal(["{\"event\":\"log\"}", "{\"a\":1}"], buffer.Append("\"log\"}\n{\"a\":1}\r\n{\"b\""u8));
        Assert.Equal("{\"b\"", buffer.Flush());
        Assert.Null(buffer.Flush());
    }

    [Fact]
    public void KeepsMultiByteCharactersSplitBetweenReads()
    {
        var bytes = Encoding.UTF8.GetBytes("Schreibe auf „USB“ ✓\n");
        var split = Array.IndexOf(bytes, (byte)0xE2) + 1; // inside the first 3-byte character
        var buffer = new JsonlLineBuffer();
        Assert.Empty(buffer.Append(bytes.AsSpan(0, split)));
        Assert.Equal(["Schreibe auf „USB“ ✓"], buffer.Append(bytes.AsSpan(split)));
    }
}
