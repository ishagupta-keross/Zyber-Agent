// Worker.cs
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public class Worker : BackgroundService
{
    private readonly ILogger<Worker> _logger;

    // ===== Win32 APIs for focused time (your original logic) =====
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    // ===== Win32 APIs for screen time (new) =====
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    const int GWL_STYLE = -16;
    const uint WS_MINIMIZE = 0x20000000;

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    // ===== Focused Time Tracking (your original) =====
    private string _currentProcessName = "";
    private string _currentWindowTitle = "";
    private DateTime _sessionStartTime = DateTime.MinValue;

    // ===== Screen Time Tracking (new) =====
    private readonly ConcurrentDictionary<string, DateTime> _visibleAppStartTimes = new();
    private readonly HashSet<string> _currentlyVisibleApps = new();
    private readonly object _visibleAppsLock = new();

    // ===== Ignore system apps =====
    private static readonly HashSet<string> IgnoredProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer", "dllhost", "audiodg", "sihost", "taskhostw", "svchost",
        "runtimebroker", "searchapp", "ctfmon", "conhost", "fontdrvhost"
    };

    public Worker(ILogger<Worker> logger)
    {
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Child activity monitor started.");

        // Run focused-time loop (every 1 sec)
        _ = Task.Run(async () =>
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    var (title, processName) = GetActiveWindowInfo();

                    if (!string.IsNullOrWhiteSpace(title) && !string.IsNullOrWhiteSpace(processName))
                    {
                        if (processName != _currentProcessName || title != _currentWindowTitle)
                        {
                            EndCurrentSession();
                            _currentProcessName = processName;
                            _currentWindowTitle = title;
                            _sessionStartTime = DateTime.Now;
                            _logger.LogInformation($"[FOCUSED] New session: {processName} - '{title}'");
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[FOCUSED] Error in monitoring loop");
                }
                await Task.Delay(1000, stoppingToken);
            }
        }, stoppingToken);

        // Run screen-time loop (every 5 sec)
        using var screenTimeTimer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (await screenTimeTimer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await TrackVisibleWindows();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[SCREEN TIME] Error tracking visible windows");
            }
        }
    }

    // ===== Focused Time Helpers (your original, slightly enhanced) =====
    private (string title, string processName) GetActiveWindowInfo()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return ("", "");

        var sb = new StringBuilder(1024);
        GetWindowText(hwnd, sb, sb.Capacity);
        string title = sb.ToString().Trim();
        if (string.IsNullOrEmpty(title)) return ("", "");

        try
        {
            GetWindowThreadProcessId(hwnd, out uint pid);
            var process = Process.GetProcessById((int)pid);
            return (title, IgnoredProcesses.Contains(process.ProcessName) ? "" : process.ProcessName);
        }
        catch
        {
            return (title, "unknown");
        }
    }

    private void EndCurrentSession()
    {
        if (_sessionStartTime == DateTime.MinValue) return;

        var duration = (DateTime.Now - _sessionStartTime).TotalSeconds;
        if (duration >= 1)
        {
            var logEntry = new
            {
                timestamp = DateTime.UtcNow,
                localTimestamp = DateTime.Now,
                machineName = Environment.MachineName,
                userName = Environment.UserName,
                appName = _currentProcessName,
                windowTitle = _currentWindowTitle,
                durationSeconds = (int)duration,
                executablePath = GetExecutablePath(_currentProcessName),
                screenTime = false // ← focused time
            };

            _logger.LogInformation("[FOCUSED] Session ended: {AppName} ({Duration}s)", _currentProcessName, (int)duration);
            _ = SendToDashboard(logEntry);
        }

        _currentProcessName = "";
        _currentWindowTitle = "";
        _sessionStartTime = DateTime.MinValue;
    }

    // ===== Screen Time Logic (new) =====
    private async Task TrackVisibleWindows()
    {
        var visibleAppsNow = new HashSet<string>();

        EnumWindows((hWnd, _) =>
        {
            if (!IsWindowVisible(hWnd) || IsWindowMinimized(hWnd))
                return true;

            try
            {
                GetWindowThreadProcessId(hWnd, out uint pid);
                var process = Process.GetProcessById((int)pid);
                var appName = process.ProcessName;

                if (IgnoredProcesses.Contains(appName))
                    return true;

                visibleAppsNow.Add(appName);
            }
            catch { /* ignore */ }

            return true;
        }, IntPtr.Zero);

        lock (_visibleAppsLock)
        {
            // End sessions for apps no longer visible
            foreach (var app in _currentlyVisibleApps.Except(visibleAppsNow))
            {
                if (_visibleAppStartTimes.TryRemove(app, out var startTime))
                {
                    var duration = (DateTime.Now - startTime).TotalSeconds;
                    if (duration >= 2)
                    {
                        var logEntry = new
                        {
                            timestamp = DateTime.UtcNow,
                            localTimestamp = DateTime.Now,
                            machineName = Environment.MachineName,
                            userName = Environment.UserName,
                            appName = app,
                            windowTitle = "(Visible Window)",
                            durationSeconds = (int)duration,
                            executablePath = GetExecutablePath(app),
                            screenTime = true // ← screen time
                        };

                        _logger.LogInformation("[SCREEN TIME] Session ended: {AppName} ({Duration}s)", app, (int)duration);
                        _ = SendToDashboard(logEntry);
                    }
                }
            }

            // Start new sessions
            foreach (var app in visibleAppsNow.Except(_currentlyVisibleApps))
            {
                _visibleAppStartTimes[app] = DateTime.Now;
            }

            _currentlyVisibleApps.Clear();
            foreach (var app in visibleAppsNow) _currentlyVisibleApps.Add(app);
        }
    }

    private bool IsWindowMinimized(IntPtr hWnd)
    {
        var style = GetWindowLong(hWnd, GWL_STYLE);
        return (style & (int)WS_MINIMIZE) != 0;
    }

    // ===== Shared Helpers =====
    private string GetExecutablePath(string processName)
    {
        try
        {
            var processes = Process.GetProcessesByName(processName);
            return processes.Length > 0 ? processes[0].MainModule?.FileName ?? "" : "";
        }
        catch
        {
            return "";
        }
    }

    private async Task SendToDashboard(object logEntry)
    {
        try
        {
            using var httpClient = new HttpClient();
            httpClient.Timeout = TimeSpan.FromSeconds(10);
            httpClient.DefaultRequestHeaders.Add("Authorization", "Bearer my_strong_secret_12345");

            var json = JsonSerializer.Serialize(logEntry);
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            // ⚠️ Update this IP when deploying to child PC!
            // var response = await httpClient.PostAsync("http://localhost:3001/api/activity", content);
            var response = await httpClient.PostAsync("http://192.168.3.10:3001/api/activity", content);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("❌ Dashboard rejected log: {StatusCode}", response.StatusCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "🔥 Failed to send activity to dashboard");
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Shutting down monitor...");
        EndCurrentSession();

        // Flush any remaining screen time
        lock (_visibleAppsLock)
        {
            foreach (var app in _currentlyVisibleApps)
            {
                if (_visibleAppStartTimes.TryRemove(app, out var startTime))
                {
                    var duration = (DateTime.Now - startTime).TotalSeconds;
                    if (duration >= 1)
                    {
                        var logEntry = new
                        {
                            timestamp = DateTime.UtcNow,
                            appName = app,
                            windowTitle = "(Visible Window - Shutdown)",
                            durationSeconds = (int)duration,
                            screenTime = true
                        };
                        _ = SendToDashboard(logEntry);
                    }
                }
            }
        }

        await base.StopAsync(cancellationToken);
    }
}