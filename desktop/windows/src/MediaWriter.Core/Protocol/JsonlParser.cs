using System.Text;
using System.Text.Json;

namespace TunaOS.MediaWriter.Core.Protocol;

/// <summary>
/// Parses one line of helper output into a <see cref="HelperEvent"/>. Never throws:
/// anything that is not a JSON object with an <c>event</c> string becomes a
/// <see cref="MalformedLine"/> so a stray line cannot take the GUI down.
/// Unknown fields are ignored (forward compatibility with newer helpers).
/// </summary>
public static class JsonlParser
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>Returns <c>null</c> for blank lines.</summary>
    public static HelperEvent? ParseLine(string line)
    {
        // A BOM can lead the first line when a Windows tool created the events file.
        var text = line.Trim().TrimStart('\uFEFF').Trim();
        if (text.Length == 0)
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return new MalformedLine(text, "not a JSON object");
            }

            if (!root.TryGetProperty("event", out var name) || name.ValueKind != JsonValueKind.String)
            {
                return new MalformedLine(text, "missing \"event\" field");
            }

            return name.GetString() switch
            {
                "progress" => new ProgressEvent(
                    Str(root, "phase"), Long(root, "current"), Long(root, "total"), Str(root, "unit"), Str(root, "message")),
                "log" => new LogEvent(Str(root, "level"), Str(root, "message")),
                "error" => new ErrorEvent(Str(root, "kind"), Str(root, "message")),
                "version" => new VersionEvent(Str(root, "helper"), Str(root, "engine"), (int)Long(root, "protocol")),
                "catalog" => new CatalogEvent(root.Deserialize<Catalog>(Options) ?? new Catalog()),
                "drives" => new DrivesEvent(
                    root.TryGetProperty("drives", out var drives) && drives.ValueKind == JsonValueKind.Array
                        ? drives.Deserialize<List<Drive>>(Options) ?? []
                        : []),
                "done" when root.TryGetProperty("device", out _) =>
                    new WriteDoneEvent(Str(root, "device"), Long(root, "bytes"), Bool(root, "verified")),
                "done" => new BuildDoneEvent(Str(root, "path"), Long(root, "bytes"), Str(root, "sha256")),
                var other => new UnknownEvent(other ?? "", text),
            };
        }
        catch (JsonException ex)
        {
            return new MalformedLine(text, ex.Message);
        }
        catch (InvalidOperationException ex)
        {
            // Deserialize<T> on a field of the wrong JSON type.
            return new MalformedLine(text, ex.Message);
        }
    }

    private static string Str(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static long Long(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Number)
        {
            return 0;
        }

        if (v.TryGetInt64(out var l))
        {
            return l;
        }

        return v.TryGetDouble(out var d) ? (long)d : 0;
    }

    private static bool Bool(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}

/// <summary>
/// Splits a byte stream into UTF-8 lines. Used to tail the <c>--events</c> file the
/// elevated helper appends to: a read can end in the middle of a line, or in the
/// middle of a multi-byte character, and both must wait for the next chunk.
/// </summary>
public sealed class JsonlLineBuffer
{
    private readonly List<byte> _pending = [];

    /// <summary>Appends a chunk and returns every line it completed (without the terminator).</summary>
    public IReadOnlyList<string> Append(ReadOnlySpan<byte> chunk)
    {
        var lines = new List<string>();
        foreach (var b in chunk)
        {
            if (b == (byte)'\n')
            {
                lines.Add(Decode());
                _pending.Clear();
            }
            else
            {
                _pending.Add(b);
            }
        }

        return lines;
    }

    /// <summary>Returns the trailing unterminated line, if any (call once the writer is gone).</summary>
    public string? Flush()
    {
        if (_pending.Count == 0)
        {
            return null;
        }

        var line = Decode();
        _pending.Clear();
        return line;
    }

    private string Decode()
    {
        var count = _pending.Count;
        if (count > 0 && _pending[count - 1] == (byte)'\r')
        {
            count--;
        }

        return Encoding.UTF8.GetString(_pending.ToArray(), 0, count);
    }
}
