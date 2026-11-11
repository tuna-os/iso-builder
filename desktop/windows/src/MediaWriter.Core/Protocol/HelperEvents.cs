namespace TunaOS.MediaWriter.Core.Protocol;

/// <summary>One parsed line of the helper's JSON Lines output (desktop/PROTOCOL.md).</summary>
public abstract record HelperEvent;

/// <summary><c>{"event":"progress",...}</c>. <see cref="Total"/> is 0 when the helper cannot know it.</summary>
public sealed record ProgressEvent(string Phase, long Current, long Total, string Unit, string Message) : HelperEvent;

/// <summary><c>{"event":"log","level":"info|warn",...}</c>.</summary>
public sealed record LogEvent(string Level, string Message) : HelperEvent;

/// <summary><c>{"event":"error","kind":...,"message":...}</c>; precedes exit code 1.</summary>
public sealed record ErrorEvent(string Kind, string Message) : HelperEvent;

/// <summary><c>{"event":"version",...}</c>.</summary>
public sealed record VersionEvent(string Helper, string Engine, int Protocol) : HelperEvent;

/// <summary><c>{"event":"catalog",...}</c>.</summary>
public sealed record CatalogEvent(Catalog Catalog) : HelperEvent;

/// <summary><c>{"event":"drives","drives":[...]}</c>.</summary>
public sealed record DrivesEvent(IReadOnlyList<Drive> Drives) : HelperEvent;

/// <summary><c>{"event":"done","path":...}</c> emitted by <c>build</c>.</summary>
public sealed record BuildDoneEvent(string Path, long Bytes, string Sha256) : HelperEvent;

/// <summary><c>{"event":"done","device":...}</c> emitted by <c>write</c>.</summary>
public sealed record WriteDoneEvent(string Device, long Bytes, bool Verified) : HelperEvent;

/// <summary>A well-formed event this app does not know; ignored by the flow, kept for the details log.</summary>
public sealed record UnknownEvent(string Name, string Raw) : HelperEvent;

/// <summary>A line that is not a JSON object with an <c>event</c> string.</summary>
public sealed record MalformedLine(string Raw, string Reason) : HelperEvent;

/// <summary>Protocol error kinds (the <c>kind</c> field of an error event).</summary>
public static class ErrorKinds
{
    public const string Network = "network";
    public const string Storage = "storage";
    public const string Permission = "permission";
    public const string DeviceChanged = "device-changed";
    public const string VerifyMismatch = "verify-mismatch";
    public const string Engine = "engine";
    public const string Cancelled = "cancelled";
    public const string Usage = "usage";
}

/// <summary>Helper process exit codes.</summary>
public static class HelperExitCodes
{
    public const int Success = 0;
    public const int Failure = 1;
    public const int Usage = 2;
    public const int Cancelled = 130;
}

public sealed record Catalog
{
    public string SnapshotDigest { get; init; } = "";
    public string DefaultTarget { get; init; } = "";
    // Go marshals a nil slice as null; the setters turn that into an empty list.
    public IReadOnlyList<CatalogDesktop> Desktops { get; init => field = value ?? []; } = [];
    public IReadOnlyList<CatalogBase> Bases { get; init => field = value ?? []; } = [];
    public IReadOnlyList<CatalogTarget> Targets { get; init => field = value ?? []; } = [];
}

public sealed record CatalogDesktop
{
    public string Id { get; init; } = "";
    public string Label { get; init; } = "";
    public string Description { get; init; } = "";
}

public sealed record CatalogBase
{
    public string Id { get; init; } = "";
    public string Label { get; init; } = "";
}

public sealed record CatalogTarget
{
    public string Id { get; init; } = "";
    public string Base { get; init; } = "";
    public string Desktop { get; init; } = "";
    public string Platform { get; init; } = "";
    public string Edition { get; init; } = "";
    public string Hardware { get; init; } = "";
    public string Image { get; init; } = "";
    public long CompressedSize { get; init; }
    public bool BrowserQualified { get; init; }
}

public sealed record Drive
{
    public string Id { get; init; } = "";
    public string Path { get; init; } = "";
    public string Name { get; init; } = "";
    public long SizeBytes { get; init; }
    public string Bus { get; init; } = "";
    public bool Removable { get; init; }
    public IReadOnlyList<string> Mounted { get; init => field = value ?? []; } = [];
    public bool SystemDisk { get; init; }
}
