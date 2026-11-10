using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using TunaOS.MediaWriter.Core.Protocol;

namespace TunaOS.MediaWriter.Core.Helper;

/// <summary>How to start the helper: the bundled executable, or a fake-helper script for tests and UI smoke.</summary>
public sealed record HelperCommand(string FileName, IReadOnlyList<string> PrefixArgs)
{
    public const string HelperExeName = "tunaos-media-helper.exe";

    public static HelperCommand Executable(string path) => new(path, []);

    /// <summary>
    /// <c>.ps1</c> runs under Windows PowerShell (pwsh elsewhere), <c>.sh</c> under /bin/sh,
    /// anything else is started directly.
    /// </summary>
    public static HelperCommand FakeScript(string scriptPath)
    {
        var full = Path.GetFullPath(scriptPath);
        switch (Path.GetExtension(full).ToLowerInvariant())
        {
            case ".ps1":
                var shell = OperatingSystem.IsWindows()
                    ? Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe")
                    : "pwsh";
                return new(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", full]);
            case ".sh":
                return new("/bin/sh", [full]);
            default:
                return new(full, []);
        }
    }
}

/// <summary>One helper invocation.</summary>
/// <param name="Args">Subcommand and its arguments, e.g. <c>["drives"]</c>.</param>
public sealed record HelperRequest(IReadOnlyList<string> Args)
{
    /// <summary>
    /// Run through the OS elevation prompt. The helper then reports through an
    /// <c>--events</c> file the GUI tails, because ShellExecute cannot forward stdout.
    /// </summary>
    public bool Elevated { get; init; }

    /// <summary>Pass <c>--cancel-file</c> so cancelling asks the helper to stop cleanly.</summary>
    public bool Cancellable { get; init; }
}

/// <param name="ElevationDeclined">The user answered No to the elevation prompt; the helper never ran.</param>
public sealed record HelperResult(int ExitCode, bool ElevationDeclined = false);

public interface IHelperRunner
{
    /// <summary>
    /// Runs the helper to completion. <paramref name="onEvent"/> and <paramref name="onLog"/>
    /// (stderr lines) may be called from any thread. Cancelling <paramref name="ct"/> asks the
    /// helper to stop; the task still completes with the helper's exit code.
    /// </summary>
    Task<HelperResult> RunAsync(HelperRequest request, Action<HelperEvent> onEvent, Action<string> onLog, CancellationToken ct);
}

public sealed class ProcessHelperRunnerOptions
{
    /// <summary>Use the <c>runas</c> verb for elevated requests. Off for tests and already-elevated runs.</summary>
    public bool UseRunAs { get; init; } = OperatingSystem.IsWindows();

    /// <summary>How often the events file is read while an elevated helper runs.</summary>
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromMilliseconds(200);

    /// <summary>How long a cancelled helper gets to notice the cancel file before it is killed.</summary>
    public TimeSpan CancelGrace { get; init; } = TimeSpan.FromSeconds(15);

    /// <summary>Where events and cancel files go.</summary>
    public string TempDirectory { get; init; } = Path.GetTempPath();
}

/// <summary>Starts the helper as a child process and parses its JSONL output.</summary>
public sealed class ProcessHelperRunner(HelperCommand command, ProcessHelperRunnerOptions? options = null) : IHelperRunner
{
    private const int ErrorCancelled = 1223; // ERROR_CANCELLED: user said No to UAC

    private readonly ProcessHelperRunnerOptions _options = options ?? new ProcessHelperRunnerOptions();

    public HelperCommand Command => command;

    public Task<HelperResult> RunAsync(HelperRequest request, Action<HelperEvent> onEvent, Action<string> onLog, CancellationToken ct) =>
        request.Elevated
            ? RunElevatedAsync(request, onEvent, ct)
            : RunRedirectedAsync(request, onEvent, onLog, ct);

    private async Task<HelperResult> RunRedirectedAsync(
        HelperRequest request, Action<HelperEvent> onEvent, Action<string> onLog, CancellationToken ct)
    {
        var cancelFile = request.Cancellable ? NewTempPath(".cancel") : null;
        var psi = new ProcessStartInfo(command.FileName)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            WorkingDirectory = AppContext.BaseDirectory,
        };
        foreach (var arg in BuildArgs(request, eventsFile: null, cancelFile))
        {
            psi.ArgumentList.Add(arg);
        }

        try
        {
            using var process = Process.Start(psi) ?? throw new InvalidOperationException("helper did not start");
            var stdout = PumpAsync(process.StandardOutput, line =>
            {
                var ev = JsonlParser.ParseLine(line);
                if (ev is not null)
                {
                    onEvent(ev);
                }
            });
            var stderr = PumpAsync(process.StandardError, onLog);
            using (ct.Register(() => RequestCancel(process, cancelFile)))
            {
                await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
                await Task.WhenAll(stdout, stderr).ConfigureAwait(false);
            }

            return new HelperResult(process.ExitCode);
        }
        finally
        {
            TryDelete(cancelFile);
        }
    }

    private async Task<HelperResult> RunElevatedAsync(HelperRequest request, Action<HelperEvent> onEvent, CancellationToken ct)
    {
        var eventsFile = NewTempPath(".jsonl");
        var cancelFile = request.Cancellable ? NewTempPath(".cancel") : null;
        await File.WriteAllBytesAsync(eventsFile, [], CancellationToken.None).ConfigureAwait(false);
        try
        {
            var psi = new ProcessStartInfo(command.FileName)
            {
                UseShellExecute = true,
                Verb = _options.UseRunAs ? "runas" : "",
                WindowStyle = ProcessWindowStyle.Hidden,
                Arguments = CommandLine.Join(BuildArgs(request, eventsFile, cancelFile)),
                WorkingDirectory = AppContext.BaseDirectory,
            };

            Process? started;
            try
            {
                started = Process.Start(psi);
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == ErrorCancelled)
            {
                return new HelperResult(HelperExitCodes.Cancelled, ElevationDeclined: true);
            }

            using var process = started ?? throw new InvalidOperationException("helper did not start");
            using var stream = new FileStream(
                eventsFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var lines = new JsonlLineBuffer();
            var chunk = new byte[64 * 1024];
            using (ct.Register(() => RequestCancel(process, cancelFile)))
            {
                while (true)
                {
                    // Sample exit before draining so the final drain sees every byte written.
                    var exited = process.HasExited;
                    int read;
                    while ((read = await stream.ReadAsync(chunk, CancellationToken.None).ConfigureAwait(false)) > 0)
                    {
                        Emit(lines.Append(chunk.AsSpan(0, read)), onEvent);
                    }

                    if (exited)
                    {
                        break;
                    }

                    await Task.Delay(_options.PollInterval, CancellationToken.None).ConfigureAwait(false);
                }
            }

            var tail = lines.Flush();
            if (tail is not null)
            {
                Emit([tail], onEvent);
            }

            return new HelperResult(process.ExitCode);
        }
        finally
        {
            TryDelete(cancelFile);
            TryDelete(eventsFile);
        }
    }

    private static void Emit(IReadOnlyList<string> lines, Action<HelperEvent> onEvent)
    {
        foreach (var line in lines)
        {
            var ev = JsonlParser.ParseLine(line);
            if (ev is not null)
            {
                onEvent(ev);
            }
        }
    }

    private IEnumerable<string> BuildArgs(HelperRequest request, string? eventsFile, string? cancelFile)
    {
        foreach (var arg in command.PrefixArgs)
        {
            yield return arg;
        }

        foreach (var arg in request.Args)
        {
            yield return arg;
        }

        if (eventsFile is not null)
        {
            yield return "--events";
            yield return eventsFile;
        }

        if (cancelFile is not null)
        {
            yield return "--cancel-file";
            yield return cancelFile;
        }
    }

    private void RequestCancel(Process process, string? cancelFile)
    {
        if (cancelFile is not null)
        {
            try
            {
                File.WriteAllText(cancelFile, "cancel");
            }
            catch (IOException)
            {
            }

            _ = KillAfterAsync(process, _options.CancelGrace);
            return;
        }

        TryKill(process);
    }

    private static async Task KillAfterAsync(Process process, TimeSpan grace)
    {
        await Task.Delay(grace).ConfigureAwait(false);
        TryKill(process);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException)
        {
            // Already gone, or elevated (a non-elevated parent cannot terminate it; the
            // cancel file is the only way to stop it).
        }
    }

    private static async Task PumpAsync(StreamReader reader, Action<string> onLine)
    {
        while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
        {
            onLine(line);
        }
    }

    private string NewTempPath(string extension) =>
        Path.Combine(_options.TempDirectory, $"tunaos-media-writer-{Guid.NewGuid():N}{extension}");

    private static void TryDelete(string? path)
    {
        if (path is null)
        {
            return;
        }

        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}

/// <summary>Builds a Windows command line (CommandLineToArgvW / MSVCRT quoting rules).</summary>
public static class CommandLine
{
    public static string Join(IEnumerable<string> args) => string.Join(' ', args.Select(Quote));

    public static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0)
        {
            return arg;
        }

        var sb = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }

            if (c == '"')
            {
                sb.Append('\\', (backslashes * 2) + 1).Append('"');
            }
            else
            {
                sb.Append('\\', backslashes).Append(c);
            }

            backslashes = 0;
        }

        sb.Append('\\', backslashes * 2).Append('"');
        return sb.ToString();
    }
}
