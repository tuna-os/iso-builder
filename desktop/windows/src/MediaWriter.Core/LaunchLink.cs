using System.Text.RegularExpressions;

namespace TunaOS.MediaWriter.Core;

/// <summary>Why <see cref="LaunchLink"/> refused a value.</summary>
public enum LinkFailure
{
    NotALink,
    UnknownAction,
    MissingTarget,
    InvalidTargetId,
    InvalidCell,
    InvalidDigest,
}

public sealed class LaunchLinkException(LinkFailure failure, string value)
    : FormatException($"{failure}: {value}")
{
    public LinkFailure Failure { get; } = failure;
}

/// <summary>
/// Links from iso.tunaos.org that open the app on a catalog target (desktop/PROTOCOL.md,
/// "Opening the app on a target"):
/// <c>TunaOSMediaWriter.exe --target yellowfin:gnome:linux/amd64</c> and
/// <c>tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64</c>, which the
/// MSI registers as a URL protocol whose command passes the link as the only argument.
/// Only the form is checked here; whether the catalog offers the target is
/// <see cref="MediaWriterFlow.OpenTarget"/>'s decision.
/// </summary>
public static partial class LaunchLink
{
    public const string Scheme = "tunaos-media-writer";
    public const string Action = "build";

    /// <summary>True for a command-line argument that is one of our links (any case).</summary>
    public static bool IsLink(string arg) => arg.StartsWith(Scheme + ":", StringComparison.OrdinalIgnoreCase);

    /// <summary>The <c>--target</c> value, checked for the shape of a catalog target id.</summary>
    public static string TargetId(string value) =>
        TargetIdPattern().IsMatch(value) ? value : throw new LaunchLinkException(LinkFailure.InvalidTargetId, value);

    /// <summary>The target id of a <c>tunaos-media-writer://build?target=ID</c> link.</summary>
    public static string TargetIdFromUri(string link)
    {
        if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || !uri.Scheme.Equals(Scheme, StringComparison.OrdinalIgnoreCase))
        {
            throw new LaunchLinkException(LinkFailure.NotALink, link);
        }

        if (!uri.Host.Equals(Action, StringComparison.OrdinalIgnoreCase) || uri.AbsolutePath is not ("" or "/"))
        {
            throw new LaunchLinkException(LinkFailure.UnknownAction, link);
        }

        var targets = uri.Query.TrimStart('?')
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair => pair.Split('=', 2))
            .Where(kv => kv[0] == "target" && kv.Length == 2 && kv[1].Length > 0)
            .Select(kv => Uri.UnescapeDataString(kv[1]))
            .ToList();
        if (targets.Count != 1)
        {
            throw new LaunchLinkException(LinkFailure.MissingTarget, link);
        }

        return TargetId(targets[0]);
    }

    // TODO(writer-665): not compiled on this host; the Windows CI job covers it.
    // Mirrors the tested Python parser in desktop/linux/launch.py.
    /// <summary>The optional <c>cell</c> and <c>digest</c> of a build link (empty when absent).</summary>
    public static (string Cell, string Digest) CellAndDigestFromUri(string link)
    {
        if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || !uri.Scheme.Equals(Scheme, StringComparison.OrdinalIgnoreCase))
        {
            throw new LaunchLinkException(LinkFailure.NotALink, link);
        }

        List<string> Values(string name) => uri.Query.TrimStart('?')
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair => pair.Split('=', 2))
            .Where(kv => kv[0] == name && kv.Length == 2 && kv[1].Length > 0)
            .Select(kv => Uri.UnescapeDataString(kv[1]))
            .ToList();
        var cells = Values("cell");
        var digests = Values("digest");
        if (cells.Count > 1 || digests.Count > 1)
        {
            throw new LaunchLinkException(LinkFailure.InvalidCell, link);
        }

        var cell = cells.Count == 1 ? cells[0] : "";
        var digest = digests.Count == 1 ? digests[0] : "";
        if (cell.Any(char.IsWhiteSpace) || cell.Contains('?') || cell.Contains('#') || cell.Length > 1024)
        {
            throw new LaunchLinkException(LinkFailure.InvalidCell, cell);
        }

        if (digest.Length > 0)
        {
            if (!DigestPattern().IsMatch(digest))
            {
                throw new LaunchLinkException(LinkFailure.InvalidDigest, digest);
            }

            if (cell.Length == 0)
            {
                throw new LaunchLinkException(LinkFailure.InvalidDigest, link);
            }
        }

        return (cell, digest);
    }

    /// <summary>base:desktop:os/arch[/variant], as the catalog's target ids are spelled.</summary>
    [GeneratedRegex(@"\A[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*:[a-z0-9]+(/[a-z0-9._-]+)+\z")]
    private static partial Regex TargetIdPattern();

    /// <summary>A manifest digest pins the exact image bytes a cell link means.</summary>
    [GeneratedRegex(@"\Asha256:[0-9a-fA-F]{64}\z")]
    private static partial Regex DigestPattern();
}
