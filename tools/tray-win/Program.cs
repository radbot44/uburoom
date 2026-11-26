// uburoom Windows system-tray wrapper (GPL-3.0-only).
// Launches bundled node.exe + scripts/launcher.js with no visible console window,
// redirects stdout/stderr to a rotating log under config/data/uburoom-launcher.log,
// tracks the active setup/server URL over a private user-only Named Pipe, and provides
// native tray controls for everyday Windows users.
//
// Target: .NET Framework 4.x inbox compiler (csc.exe v4.0.30319, C# 5 syntax, zero SDKs).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace UburoomTray
{
    internal static class NativeMethods
    {
        private static readonly IntPtr DpiAwarenessContextPerMonitorAwareV2 = new IntPtr(-4);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDPIAware();

        public static void EnableDpiAwareness()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(DpiAwarenessContextPerMonitorAwareV2))
                {
                    return;
                }
            }
            catch (EntryPointNotFoundException)
            {
            }
            catch (DllNotFoundException)
            {
            }

            try
            {
                SetProcessDPIAware();
            }
            catch (EntryPointNotFoundException)
            {
            }
            catch (DllNotFoundException)
            {
            }
        }
    }

    internal sealed class TrayOptions
    {
        public string PortableRoot;
        public string NodeOverride;
        public bool QuitRunning;
        public long MaxLogBytes = 5 * 1024 * 1024;
        public List<string> ForwardedArgs = new List<string>();

        public static TrayOptions Parse(string[] args, string defaultRoot)
        {
            TrayOptions options = new TrayOptions();
            options.PortableRoot = defaultRoot;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--quit")
                {
                    options.QuitRunning = true;
                    continue;
                }
                if (arg == "--root" && i + 1 < args.Length)
                {
                    options.PortableRoot = Path.GetFullPath(args[++i]);
                    continue;
                }
                if (arg.StartsWith("--root=", StringComparison.Ordinal))
                {
                    string val = arg.Substring("--root=".Length);
                    if (!string.IsNullOrEmpty(val))
                    {
                        options.PortableRoot = Path.GetFullPath(val);
                    }
                    continue;
                }
                if (arg == "--node" && i + 1 < args.Length)
                {
                    options.NodeOverride = Path.GetFullPath(args[++i]);
                    continue;
                }
                if (arg.StartsWith("--node=", StringComparison.Ordinal))
                {
                    string val = arg.Substring("--node=".Length);
                    if (!string.IsNullOrEmpty(val))
                    {
                        options.NodeOverride = Path.GetFullPath(val);
                    }
                    continue;
                }
                if (arg == "--max-log-bytes" && i + 1 < args.Length)
                {
                    long parsed;
                    if (long.TryParse(args[++i], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed >= 1024)
                    {
                        options.MaxLogBytes = parsed;
                    }
                    continue;
                }
                if (arg.StartsWith("--max-log-bytes=", StringComparison.Ordinal))
                {
                    long parsed;
                    if (long.TryParse(arg.Substring("--max-log-bytes=".Length), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed >= 1024)
                    {
                        options.MaxLogBytes = parsed;
                    }
                    continue;
                }

                options.ForwardedArgs.Add(arg);
            }

            options.PortableRoot = Path.GetFullPath(options.PortableRoot).TrimEnd('\\', '/');
            return options;
        }
    }

    internal sealed class RotatingLog : IDisposable
    {
        private static readonly Regex AnsiRegex = new Regex(@"\x1B\[[0-9;]*[A-Za-z]", RegexOptions.Compiled);
        private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

        private readonly object _sync = new object();
        private readonly string _logPath;
        private readonly long _maxBytes;
        private readonly int _maxBackups;
        private FileStream _stream;
        private long _currentBytes;
        private bool _disposed;

        public string LogPath
        {
            get { return _logPath; }
        }

        public RotatingLog(string logPath, long maxBytes, int maxBackups)
        {
            _logPath = logPath;
            _maxBytes = maxBytes >= 1024 ? maxBytes : 5 * 1024 * 1024;
            _maxBackups = maxBackups >= 1 ? maxBackups : 3;
            EnsureOpen();
        }

        private void EnsureOpen()
        {
            if (_disposed || _stream != null)
            {
                return;
            }
            string dir = Path.GetDirectoryName(_logPath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            _stream = new FileStream(_logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            _currentBytes = _stream.Length;
            if (_currentBytes >= _maxBytes)
            {
                RotateLocked();
            }
        }

        private void RotateLocked()
        {
            CloseStreamLocked();
            try
            {
                for (int i = _maxBackups; i >= 1; i--)
                {
                    string target = _logPath + "." + i.ToString(CultureInfo.InvariantCulture);
                    string source = (i == 1) ? _logPath : (_logPath + "." + (i - 1).ToString(CultureInfo.InvariantCulture));
                    if (File.Exists(target))
                    {
                        File.Delete(target);
                    }
                    if (File.Exists(source))
                    {
                        File.Move(source, target);
                    }
                }
            }
            catch
            {
                // Keep logging even if a viewer temporarily holds an older backup file.
            }

            _stream = new FileStream(_logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            _currentBytes = 0;
        }

        private void CloseStreamLocked()
        {
            if (_stream != null)
            {
                try
                {
                    _stream.Flush();
                    _stream.Dispose();
                }
                catch
                {
                }
                _stream = null;
            }
        }

        public void WriteLine(string line)
        {
            if (line == null)
            {
                return;
            }
            string clean = AnsiRegex.Replace(line, string.Empty);
            byte[] bytes = Utf8NoBom.GetBytes(clean + Environment.NewLine);
            lock (_sync)
            {
                if (_disposed)
                {
                    return;
                }
                try
                {
                    EnsureOpen();
                    if (_currentBytes > 0 && _currentBytes + bytes.Length > _maxBytes)
                    {
                        RotateLocked();
                    }
                    _stream.Write(bytes, 0, bytes.Length);
                    _stream.Flush();
                    _currentBytes += bytes.Length;
                }
                catch
                {
                }
            }
        }

        public void WriteTray(string message)
        {
            string stamp = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
            WriteLine(string.Format(CultureInfo.InvariantCulture, "{0} INFO  [tray] {1}", stamp, message));
        }

        public void Dispose()
        {
            lock (_sync)
            {
                if (_disposed)
                {
                    return;
                }
                _disposed = true;
                CloseStreamLocked();
            }
        }
    }

    internal static class SimpleJson
    {
        // Parses a flat JSON object into string-valued fields (sufficient for NDJSON tray status messages).
        public static Dictionary<string, string> ParseFlatObject(string json)
        {
            Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(json))
            {
                return result;
            }

            int pos = 0;
            int len = json.Length;
            SkipWhitespace(json, ref pos);
            if (pos >= len || json[pos] != '{')
            {
                return result;
            }
            pos++;

            while (pos < len)
            {
                SkipWhitespace(json, ref pos);
                if (pos >= len || json[pos] == '}')
                {
                    break;
                }
                if (json[pos] == ',')
                {
                    pos++;
                    continue;
                }

                string key;
                if (!ReadString(json, ref pos, out key))
                {
                    break;
                }
                SkipWhitespace(json, ref pos);
                if (pos >= len || json[pos] != ':')
                {
                    break;
                }
                pos++;
                SkipWhitespace(json, ref pos);
                if (pos >= len)
                {
                    break;
                }

                string value;
                if (json[pos] == '"')
                {
                    if (!ReadString(json, ref pos, out value))
                    {
                        break;
                    }
                    result[key] = value;
                }
                else
                {
                    int start = pos;
                    int depth = 0;
                    bool inStr = false;
                    while (pos < len)
                    {
                        char c = json[pos];
                        if (inStr)
                        {
                            if (c == '\\' && pos + 1 < len)
                            {
                                pos += 2;
                                continue;
                            }
                            if (c == '"')
                            {
                                inStr = false;
                            }
                        }
                        else
                        {
                            if (c == '"')
                            {
                                inStr = true;
                            }
                            else if (c == '{' || c == '[')
                            {
                                depth++;
                            }
                            else if (c == '}' || c == ']')
                            {
                                if (depth == 0)
                                {
                                    break;
                                }
                                depth--;
                            }
                            else if (c == ',' && depth == 0)
                            {
                                break;
                            }
                        }
                        pos++;
                    }
                    string raw = json.Substring(start, pos - start).Trim();
                    if (!string.Equals(raw, "null", StringComparison.Ordinal))
                    {
                        result[key] = raw;
                    }
                }
            }

            return result;
        }

        private static void SkipWhitespace(string text, ref int pos)
        {
            while (pos < text.Length && char.IsWhiteSpace(text[pos]))
            {
                pos++;
            }
        }

        private static bool ReadString(string text, ref int pos, out string value)
        {
            value = null;
            if (pos >= text.Length || text[pos] != '"')
            {
                return false;
            }
            pos++;
            StringBuilder sb = new StringBuilder();
            while (pos < text.Length)
            {
                char c = text[pos++];
                if (c == '"')
                {
                    value = sb.ToString();
                    return true;
                }
                if (c == '\\')
                {
                    if (pos >= text.Length)
                    {
                        return false;
                    }
                    char esc = text[pos++];
                    switch (esc)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (pos + 4 > text.Length)
                            {
                                return false;
                            }
                            int code;
                            if (!int.TryParse(text.Substring(pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            {
                                return false;
                            }
                            sb.Append((char)code);
                            pos += 4;
                            break;
                        default:
                            sb.Append(esc);
                            break;
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }
            return false;
        }
    }

    internal sealed class TrayApplicationContext : ApplicationContext
    {
        private static readonly Regex SlotPattern = new Regex(@"^[A-Za-z0-9._-]+$", RegexOptions.Compiled);
        private const int ShutdownGraceMs = 15000;

        private readonly TrayOptions _options;
        private readonly RotatingLog _log;
        private readonly Control _uiMarshal;
        private readonly NotifyIcon _notifyIcon;
        private readonly ContextMenuStrip _menu;
        private readonly ToolStripMenuItem _openItem;
        private readonly ToolStripMenuItem _logItem;
        private readonly ToolStripMenuItem _doctorItem;
        private readonly ToolStripMenuItem _restartItem;
        private readonly ToolStripMenuItem _quitItem;
        private readonly Icon _trayIcon;
        private readonly EventWaitHandle _activateEvent;
        private readonly EventWaitHandle _quitEvent;
        private readonly RegisteredWaitHandle _activateWait;
        private readonly RegisteredWaitHandle _quitWait;

        private readonly object _procSync = new object();
        private Process _launcherProcess;
        private NamedPipeServerStream _pipeServer;
        private StreamWriter _pipeWriter;
        private long _generation;
        private bool _isQuitting;
        private bool _isRestarting;
        private bool _exited;
        private string _activeUrl;
        private string _currentState = "starting";

        public TrayApplicationContext(TrayOptions options, EventWaitHandle activateEvent, EventWaitHandle quitEvent)
        {
            _options = options;
            _activateEvent = activateEvent;
            _quitEvent = quitEvent;

            string logFile = Path.Combine(options.PortableRoot, "config", "data", "uburoom-launcher.log");
            _log = new RotatingLog(logFile, options.MaxLogBytes, 3);

            _uiMarshal = new Control();
            IntPtr handle = _uiMarshal.Handle;
            if (handle == IntPtr.Zero)
            {
                throw new InvalidOperationException("Failed to initialize tray UI marshal handle.");
            }

            _trayIcon = LoadTrayIcon();

            _openItem = new ToolStripMenuItem("Open uburoom", null, OnOpenClicked);
            _openItem.Font = new Font(_openItem.Font, FontStyle.Bold);
            _openItem.Enabled = false;

            _logItem = new ToolStripMenuItem("View log", null, OnViewLogClicked);
            _doctorItem = new ToolStripMenuItem("Run doctor", null, OnRunDoctorClicked);
            _restartItem = new ToolStripMenuItem("Restart uburoom", null, OnRestartClicked);
            _quitItem = new ToolStripMenuItem("Quit uburoom", null, OnQuitClicked);

            _menu = new ContextMenuStrip();
            _menu.Items.Add(_openItem);
            _menu.Items.Add(_logItem);
            _menu.Items.Add(_doctorItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(_restartItem);
            _menu.Items.Add(_quitItem);

            _notifyIcon = new NotifyIcon();
            _notifyIcon.Icon = _trayIcon;
            _notifyIcon.ContextMenuStrip = _menu;
            _notifyIcon.Text = ClampTooltip("uburoom \u2014 Starting...");
            _notifyIcon.DoubleClick += OnOpenClicked;
            _notifyIcon.Visible = true;

            _activateWait = ThreadPool.RegisterWaitForSingleObject(
                _activateEvent,
                delegate(object state, bool timedOut)
                {
                    InvokeUi(OnExternalActivate);
                },
                null,
                Timeout.Infinite,
                false);

            _quitWait = ThreadPool.RegisterWaitForSingleObject(
                _quitEvent,
                delegate(object state, bool timedOut)
                {
                    InvokeUi(BeginQuit);
                },
                null,
                Timeout.Infinite,
                false);

            SystemEvents.SessionEnding += OnSessionEnding;

            StartLauncher(false);
        }

        private static Icon LoadTrayIcon()
        {
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream stream = asm.GetManifestResourceStream("uburoom.ico"))
                {
                    if (stream != null)
                    {
                        return new Icon(stream, SystemInformation.SmallIconSize);
                    }
                }
            }
            catch
            {
            }

            try
            {
                Icon extracted = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (extracted != null)
                {
                    return extracted;
                }
            }
            catch
            {
            }

            return (Icon)SystemIcons.Application.Clone();
        }

        private static string ClampTooltip(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return "uburoom";
            }
            return text.Length <= 63 ? text : text.Substring(0, 63);
        }

        private static string RedactUrlForLog(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                return "(invalid url)";
            }
            return uri.GetLeftPart(UriPartial.Path);
        }

        private static bool IsSafeHttpUrl(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
            {
                return false;
            }
            return uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
        }

        private static string QuoteArg(string value)
        {
            if (value == null)
            {
                return "\"\"";
            }
            if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) == -1)
            {
                return value;
            }
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '\\')
                {
                    backslashes++;
                }
                else if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                    backslashes = 0;
                }
                else
                {
                    if (backslashes > 0)
                    {
                        sb.Append('\\', backslashes);
                        backslashes = 0;
                    }
                    sb.Append(c);
                }
            }
            if (backslashes > 0)
            {
                sb.Append('\\', backslashes * 2);
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static string CreateRandomPipeName()
        {
            byte[] bytes = new byte[12];
            using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider())
            {
                rng.GetBytes(bytes);
            }
            StringBuilder hex = new StringBuilder(bytes.Length * 2);
            for (int i = 0; i < bytes.Length; i++)
            {
                hex.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
            }
            return string.Format(
                CultureInfo.InvariantCulture,
                "uburoom-tray-{0}-{1}",
                Process.GetCurrentProcess().Id,
                hex.ToString());
        }

        private static PipeSecurity CreateCurrentUserPipeSecurity()
        {
            PipeSecurity security = new PipeSecurity();
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity != null && identity.User != null)
                {
                    security.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
                }
            }
            return security;
        }

        private void InvokeUi(Action action)
        {
            if (_exited)
            {
                return;
            }
            try
            {
                if (_uiMarshal.IsDisposed || !_uiMarshal.IsHandleCreated)
                {
                    return;
                }
                if (_uiMarshal.InvokeRequired)
                {
                    _uiMarshal.BeginInvoke(action);
                }
                else
                {
                    action();
                }
            }
            catch (ObjectDisposedException)
            {
            }
            catch (InvalidOperationException)
            {
            }
        }

        private void UpdateUiState(string state, string url)
        {
            _currentState = state;
            if (url != null)
            {
                _activeUrl = IsSafeHttpUrl(url) ? url : null;
            }
            else if (state == "starting" || state == "restarting" || state == "stopping" || state == "stopped" || state == "error")
            {
                _activeUrl = null;
            }

            _openItem.Enabled = !string.IsNullOrEmpty(_activeUrl);
            _restartItem.Enabled = !_isQuitting && !_isRestarting;
            _quitItem.Enabled = !_isQuitting;

            string tooltip;
            if (state == "setup")
            {
                tooltip = "uburoom \u2014 Setup ready";
            }
            else if (state == "running")
            {
                tooltip = "uburoom \u2014 Running";
            }
            else if (state == "restarting")
            {
                tooltip = "uburoom \u2014 Restarting...";
            }
            else if (state == "stopping")
            {
                tooltip = "uburoom \u2014 Stopping...";
            }
            else if (state == "error")
            {
                tooltip = "uburoom \u2014 Stopped (error)";
            }
            else if (state == "stopped")
            {
                tooltip = "uburoom \u2014 Stopped";
            }
            else
            {
                tooltip = "uburoom \u2014 Starting...";
            }

            _notifyIcon.Text = ClampTooltip(tooltip);
        }

        private bool ResolveLaunchFiles(out string nodeExe, out string launcherJs, out string error)
        {
            nodeExe = null;
            launcherJs = null;
            error = null;

            string currentFile = Path.Combine(_options.PortableRoot, "current.txt");
            if (File.Exists(currentFile))
            {
                string slot = File.ReadAllText(currentFile, Encoding.UTF8).Trim();
                if (string.IsNullOrEmpty(slot) || slot == "." || slot == ".." || !SlotPattern.IsMatch(slot))
                {
                    error = "Invalid active slot in current.txt.";
                    return false;
                }
                string slotDir = Path.Combine(_options.PortableRoot, "versions", slot);
                string candidateLauncher = Path.Combine(slotDir, "app", "scripts", "launcher.js");
                if (!File.Exists(candidateLauncher))
                {
                    error = "Missing launcher script: " + candidateLauncher;
                    return false;
                }
                launcherJs = candidateLauncher;

                if (!string.IsNullOrEmpty(_options.NodeOverride) && File.Exists(_options.NodeOverride))
                {
                    nodeExe = _options.NodeOverride;
                }
                else
                {
                    string bundledNode = Path.Combine(slotDir, "runtime", "node", "node.exe");
                    nodeExe = File.Exists(bundledNode) ? bundledNode : FindNodeOnPath();
                }
                if (string.IsNullOrEmpty(nodeExe))
                {
                    error = "Missing bundled Node.js runtime for slot " + slot + ".";
                    return false;
                }
                return true;
            }

            string devLauncher = Path.Combine(_options.PortableRoot, "scripts", "launcher.js");
            if (File.Exists(devLauncher))
            {
                launcherJs = devLauncher;
                nodeExe = (!string.IsNullOrEmpty(_options.NodeOverride) && File.Exists(_options.NodeOverride))
                    ? _options.NodeOverride
                    : FindNodeOnPath();
                if (string.IsNullOrEmpty(nodeExe))
                {
                    error = "Could not find node.exe on PATH.";
                    return false;
                }
                return true;
            }

            error = "Missing current.txt in " + _options.PortableRoot + ".";
            return false;
        }

        private static string FindNodeOnPath()
        {
            string pathEnv = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(pathEnv))
            {
                return null;
            }
            string[] dirs = pathEnv.Split(Path.PathSeparator);
            for (int i = 0; i < dirs.Length; i++)
            {
                string dir = dirs[i].Trim();
                if (string.IsNullOrEmpty(dir))
                {
                    continue;
                }
                try
                {
                    string candidate = Path.Combine(dir, "node.exe");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch
                {
                }
            }
            return null;
        }

        private void StartLauncher(bool suppressBrowser)
        {
            string nodeExe;
            string launcherJs;
            string resolveError;
            if (!ResolveLaunchFiles(out nodeExe, out launcherJs, out resolveError))
            {
                _log.WriteTray("Failed to resolve uburoom installation: " + resolveError);
                UpdateUiState("error", null);
                ShowBalloon("uburoom could not start", resolveError, ToolTipIcon.Error);
                return;
            }

            long generation;
            string pipeName = CreateRandomPipeName();
            string pipePath = @"\\.\pipe\" + pipeName;
            NamedPipeServerStream pipeServer = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                4096,
                4096,
                CreateCurrentUserPipeSecurity());

            List<string> args = new List<string>();
            args.Add("--no-warnings=ExperimentalWarning");
            args.Add(launcherJs);
            args.Add("--tray-pipe");
            args.Add(pipePath);

            bool hasNoBrowser = false;
            for (int i = 0; i < _options.ForwardedArgs.Count; i++)
            {
                string a = _options.ForwardedArgs[i];
                if (a == "--no-browser")
                {
                    hasNoBrowser = true;
                }
                args.Add(a);
            }
            if (suppressBrowser && !hasNoBrowser)
            {
                args.Add("--no-browser");
            }

            StringBuilder argBuilder = new StringBuilder();
            for (int i = 0; i < args.Count; i++)
            {
                if (i > 0)
                {
                    argBuilder.Append(' ');
                }
                argBuilder.Append(QuoteArg(args[i]));
            }

            Process process = new Process();
            process.StartInfo.FileName = nodeExe;
            process.StartInfo.Arguments = argBuilder.ToString();
            process.StartInfo.WorkingDirectory = _options.PortableRoot;
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.CreateNoWindow = true;
            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.RedirectStandardError = true;
            process.StartInfo.StandardOutputEncoding = Encoding.UTF8;
            process.StartInfo.StandardErrorEncoding = Encoding.UTF8;
            process.EnableRaisingEvents = true;

            lock (_procSync)
            {
                _generation++;
                generation = _generation;
                _launcherProcess = process;
                _pipeServer = pipeServer;
                _pipeWriter = null;
            }

            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null)
                {
                    _log.WriteLine(e.Data);
                }
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null)
                {
                    _log.WriteLine(e.Data);
                }
            };
            process.Exited += delegate(object sender, EventArgs e)
            {
                int exitCode = 0;
                try
                {
                    exitCode = process.ExitCode;
                }
                catch
                {
                }
                OnLauncherExited(generation, exitCode);
            };

            UpdateUiState("starting", null);
            _log.WriteTray("Starting uburoom via " + launcherJs);

            Thread pipeThread = new Thread(delegate()
            {
                RunPipeLoop(generation, pipeServer);
            });
            pipeThread.IsBackground = true;
            pipeThread.Start();

            try
            {
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                _log.WriteTray("Failed to start node.exe: " + ex.Message);
                DisposePipe(pipeServer);
                lock (_procSync)
                {
                    if (_generation == generation)
                    {
                        _launcherProcess = null;
                        _pipeServer = null;
                        _pipeWriter = null;
                    }
                }
                UpdateUiState("error", null);
                ShowBalloon("uburoom could not start", ex.Message, ToolTipIcon.Error);
            }
        }

        private void RunPipeLoop(long generation, NamedPipeServerStream pipeServer)
        {
            try
            {
                pipeServer.WaitForConnection();
                StreamWriter writer = new StreamWriter(pipeServer, new UTF8Encoding(false));
                writer.AutoFlush = true;
                bool stopNow = false;
                lock (_procSync)
                {
                    if (_generation == generation)
                    {
                        _pipeWriter = writer;
                        stopNow = _isQuitting || _isRestarting;
                    }
                }
                if (stopNow)
                {
                    try
                    {
                        writer.WriteLine("{\"type\":\"shutdown\"}");
                    }
                    catch
                    {
                    }
                }

                using (StreamReader reader = new StreamReader(pipeServer, Encoding.UTF8, false, 1024, true))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (string.IsNullOrEmpty(line))
                        {
                            continue;
                        }
                        Dictionary<string, string> msg = SimpleJson.ParseFlatObject(line);
                        string type;
                        if (!msg.TryGetValue("type", out type) || type != "status")
                        {
                            continue;
                        }
                        string state;
                        if (!msg.TryGetValue("state", out state) || string.IsNullOrEmpty(state))
                        {
                            continue;
                        }
                        string url;
                        msg.TryGetValue("url", out url);
                        HandlePipeStatus(generation, state, url);
                    }
                }
            }
            catch (ObjectDisposedException)
            {
            }
            catch (IOException)
            {
            }
            catch (Exception ex)
            {
                _log.WriteTray("Tray IPC channel closed: " + ex.Message);
            }
            finally
            {
                lock (_procSync)
                {
                    if (_generation == generation)
                    {
                        _pipeWriter = null;
                    }
                }
                DisposePipe(pipeServer);
            }
        }

        private void HandlePipeStatus(long generation, string state, string url)
        {
            if (!string.IsNullOrEmpty(url) && IsSafeHttpUrl(url))
            {
                _log.WriteTray(string.Format(CultureInfo.InvariantCulture, "Status: {0} ({1})", state, RedactUrlForLog(url)));
            }
            else
            {
                _log.WriteTray("Status: " + state);
            }

            InvokeUi(delegate()
            {
                lock (_procSync)
                {
                    if (_generation != generation)
                    {
                        return;
                    }
                }
                if (_isQuitting || _isRestarting)
                {
                    return;
                }
                UpdateUiState(state, url);
            });
        }

        private void OnLauncherExited(long generation, int exitCode)
        {
            bool isCurrent;
            Process exitedProc = null;
            NamedPipeServerStream pipeToClose = null;

            lock (_procSync)
            {
                isCurrent = (_generation == generation);
                if (isCurrent)
                {
                    exitedProc = _launcherProcess;
                    pipeToClose = _pipeServer;
                    _launcherProcess = null;
                    _pipeServer = null;
                    _pipeWriter = null;
                }
            }

            DisposePipe(pipeToClose);
            if (exitedProc != null)
            {
                try
                {
                    exitedProc.Dispose();
                }
                catch
                {
                }
            }

            if (!isCurrent)
            {
                return;
            }

            _log.WriteTray(string.Format(CultureInfo.InvariantCulture, "Launcher exited with code {0}.", exitCode));

            InvokeUi(delegate()
            {
                if (_isQuitting || _isRestarting)
                {
                    return;
                }
                if (exitCode == 0)
                {
                    UpdateUiState("stopped", null);
                }
                else
                {
                    UpdateUiState("error", null);
                    ShowBalloon(
                        "uburoom stopped unexpectedly",
                        "Click 'View log' or 'Run doctor' from the tray menu to see why.",
                        ToolTipIcon.Warning);
                }
            });
        }

        private void SendPipeCommand(string commandType)
        {
            StreamWriter writer;
            lock (_procSync)
            {
                writer = _pipeWriter;
            }
            if (writer == null)
            {
                return;
            }
            try
            {
                writer.WriteLine(string.Format(CultureInfo.InvariantCulture, "{{\"type\":\"{0}\"}}", commandType));
            }
            catch
            {
            }
        }

        private void StopLauncherBlocking()
        {
            Process proc;
            NamedPipeServerStream pipe;
            lock (_procSync)
            {
                proc = _launcherProcess;
                pipe = _pipeServer;
            }

            if (proc == null)
            {
                DisposePipe(pipe);
                return;
            }

            int pid = -1;
            try
            {
                pid = proc.Id;
            }
            catch
            {
            }

            int waitedMs = 0;
            while (waitedMs < 2000)
            {
                bool hasWriter;
                lock (_procSync)
                {
                    hasWriter = (_pipeWriter != null);
                }
                if (hasWriter)
                {
                    break;
                }
                try
                {
                    if (proc.HasExited)
                    {
                        break;
                    }
                }
                catch
                {
                    break;
                }
                Thread.Sleep(50);
                waitedMs += 50;
            }

            SendPipeCommand("shutdown");

            bool exitedCleanly = false;
            try
            {
                exitedCleanly = proc.WaitForExit(ShutdownGraceMs);
            }
            catch
            {
                exitedCleanly = true;
            }

            if (!exitedCleanly)
            {
                _log.WriteTray("Launcher did not exit within grace period; terminating process tree.");
                if (pid > 0)
                {
                    KillProcessTree(pid);
                }
                try
                {
                    if (!proc.HasExited)
                    {
                        proc.Kill();
                    }
                    proc.WaitForExit(3000);
                }
                catch
                {
                }
            }

            DisposePipe(pipe);
            lock (_procSync)
            {
                if (_launcherProcess == proc)
                {
                    _launcherProcess = null;
                    _pipeServer = null;
                    _pipeWriter = null;
                }
            }
            try
            {
                proc.Dispose();
            }
            catch
            {
            }
        }

        private static void KillProcessTree(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "taskkill.exe";
                psi.Arguments = string.Format(CultureInfo.InvariantCulture, "/T /F /PID {0}", pid);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process tk = Process.Start(psi))
                {
                    if (tk != null)
                    {
                        tk.WaitForExit(5000);
                    }
                }
            }
            catch
            {
            }
        }

        private static void DisposePipe(NamedPipeServerStream pipe)
        {
            if (pipe == null)
            {
                return;
            }
            try
            {
                pipe.Dispose();
            }
            catch
            {
            }
        }

        private void ShowBalloon(string title, string message, ToolTipIcon icon)
        {
            try
            {
                _notifyIcon.BalloonTipTitle = title;
                _notifyIcon.BalloonTipText = message;
                _notifyIcon.BalloonTipIcon = icon;
                _notifyIcon.ShowBalloonTip(5000);
            }
            catch
            {
            }
        }

        private void OnExternalActivate()
        {
            if (!string.IsNullOrEmpty(_activeUrl) && IsSafeHttpUrl(_activeUrl))
            {
                OpenUrl(_activeUrl);
            }
            else
            {
                ShowBalloon("uburoom is already running", "Status: " + _currentState, ToolTipIcon.Info);
            }
        }

        private void OpenUrl(string url)
        {
            if (!IsSafeHttpUrl(url))
            {
                return;
            }
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(url);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                _log.WriteTray("Failed to open browser URL: " + ex.Message);
            }
        }

        private void OnOpenClicked(object sender, EventArgs e)
        {
            if (!string.IsNullOrEmpty(_activeUrl))
            {
                OpenUrl(_activeUrl);
            }
        }

        private void OnViewLogClicked(object sender, EventArgs e)
        {
            string logPath = _log.LogPath;
            try
            {
                if (!File.Exists(logPath))
                {
                    _log.WriteTray("Log file opened.");
                }
                ProcessStartInfo psi = new ProcessStartInfo(logPath);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Win32Exception)
            {
                try
                {
                    ProcessStartInfo notepad = new ProcessStartInfo("notepad.exe", QuoteArg(logPath));
                    notepad.UseShellExecute = false;
                    Process.Start(notepad);
                }
                catch (Exception ex)
                {
                    _log.WriteTray("Failed to open log file in Notepad: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                _log.WriteTray("Failed to open log file: " + ex.Message);
            }
        }

        private void OnRunDoctorClicked(object sender, EventArgs e)
        {
            string doctorBat = Path.Combine(_options.PortableRoot, "doctor.bat");
            string cmdLine;
            if (File.Exists(doctorBat))
            {
                cmdLine = string.Format(
                    CultureInfo.InvariantCulture,
                    "/c \"call {0} & echo. & pause\"",
                    QuoteArg(doctorBat));
            }
            else
            {
                string devDoctor = Path.Combine(_options.PortableRoot, "scripts", "doctor.js");
                string nodeExe = (!string.IsNullOrEmpty(_options.NodeOverride) && File.Exists(_options.NodeOverride))
                    ? _options.NodeOverride
                    : FindNodeOnPath();
                if (!File.Exists(devDoctor) || string.IsNullOrEmpty(nodeExe))
                {
                    ShowBalloon("doctor.bat not found", "Could not find doctor.bat in " + _options.PortableRoot, ToolTipIcon.Warning);
                    return;
                }
                cmdLine = string.Format(
                    CultureInfo.InvariantCulture,
                    "/c \"{0} --no-warnings=ExperimentalWarning {1} & echo. & pause\"",
                    QuoteArg(nodeExe),
                    QuoteArg(devDoctor));
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "cmd.exe";
                psi.Arguments = cmdLine;
                psi.WorkingDirectory = _options.PortableRoot;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = false;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                _log.WriteTray("Failed to launch doctor: " + ex.Message);
            }
        }

        private void OnRestartClicked(object sender, EventArgs e)
        {
            if (_isQuitting || _isRestarting)
            {
                return;
            }
            _isRestarting = true;
            UpdateUiState("restarting", null);
            _log.WriteTray("Restart requested from system tray.");

            Thread worker = new Thread(delegate()
            {
                StopLauncherBlocking();
                InvokeUi(delegate()
                {
                    _isRestarting = false;
                    if (_isQuitting)
                    {
                        return;
                    }
                    StartLauncher(true);
                });
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void OnQuitClicked(object sender, EventArgs e)
        {
            BeginQuit();
        }

        private void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            _log.WriteTray("Windows session ending; stopping uburoom.");
            _isQuitting = true;
            StopLauncherBlocking();
        }

        private void BeginQuit()
        {
            if (_isQuitting)
            {
                return;
            }
            _isQuitting = true;
            UpdateUiState("stopping", null);
            _log.WriteTray("Quit requested; stopping uburoom cleanly.");

            Thread worker = new Thread(delegate()
            {
                StopLauncherBlocking();
                InvokeUi(FinishExit);
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void FinishExit()
        {
            if (_exited)
            {
                return;
            }
            _exited = true;

            SystemEvents.SessionEnding -= OnSessionEnding;
            try
            {
                _activateWait.Unregister(null);
                _quitWait.Unregister(null);
            }
            catch
            {
            }

            try
            {
                _notifyIcon.Visible = false;
                _notifyIcon.Dispose();
            }
            catch
            {
            }

            try
            {
                _menu.Dispose();
                _trayIcon.Dispose();
                _uiMarshal.Dispose();
            }
            catch
            {
            }

            _log.Dispose();
            ExitThread();
        }
    }

    internal static class Program
    {
        private static string ComputeRootHash(string rootPath)
        {
            string normalized = Path.GetFullPath(rootPath).TrimEnd('\\', '/').ToLowerInvariant();
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(normalized));
                StringBuilder sb = new StringBuilder(24);
                for (int i = 0; i < 12; i++)
                {
                    sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
                }
                return sb.ToString();
            }
        }

        private static EventWaitHandleSecurity CreateCurrentUserEventSecurity()
        {
            EventWaitHandleSecurity security = new EventWaitHandleSecurity();
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity != null && identity.User != null)
                {
                    security.AddAccessRule(new EventWaitHandleAccessRule(identity.User, EventWaitHandleRights.FullControl, AccessControlType.Allow));
                }
            }
            return security;
        }

        private static MutexSecurity CreateCurrentUserMutexSecurity()
        {
            MutexSecurity security = new MutexSecurity();
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity != null && identity.User != null)
                {
                    security.AddAccessRule(new MutexAccessRule(identity.User, MutexRights.FullControl, AccessControlType.Allow));
                }
            }
            return security;
        }

        private static int SignalQuitAndWait(string mutexName, string quitEventName)
        {
            try
            {
                using (EventWaitHandle quitEvent = EventWaitHandle.OpenExisting(quitEventName))
                {
                    quitEvent.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                return 0;
            }

            try
            {
                using (Mutex mutex = Mutex.OpenExisting(mutexName))
                {
                    bool acquired = false;
                    try
                    {
                        acquired = mutex.WaitOne(20000);
                        return acquired ? 0 : 1;
                    }
                    catch (AbandonedMutexException)
                    {
                        acquired = true;
                        return 0;
                    }
                    finally
                    {
                        if (acquired)
                        {
                            try
                            {
                                mutex.ReleaseMutex();
                            }
                            catch
                            {
                            }
                        }
                    }
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                return 0;
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            if (string.IsNullOrEmpty(exeDir))
            {
                exeDir = Environment.CurrentDirectory;
            }

            TrayOptions options = TrayOptions.Parse(args, exeDir);
            string hash = ComputeRootHash(options.PortableRoot);
            string mutexName = @"Local\uburoom-tray-lock-" + hash;
            string activateName = @"Local\uburoom-tray-activate-" + hash;
            string quitName = @"Local\uburoom-tray-quit-" + hash;

            if (options.QuitRunning)
            {
                return SignalQuitAndWait(mutexName, quitName);
            }

            bool createdNew;
            using (Mutex singleInstance = new Mutex(true, mutexName, out createdNew, CreateCurrentUserMutexSecurity()))
            {
                if (!createdNew)
                {
                    try
                    {
                        using (EventWaitHandle activate = EventWaitHandle.OpenExisting(activateName))
                        {
                            activate.Set();
                        }
                    }
                    catch
                    {
                    }
                    return 0;
                }

                NativeMethods.EnableDpiAwareness();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                bool activateCreated;
                bool quitCreated;
                EventWaitHandleSecurity eventSec = CreateCurrentUserEventSecurity();
                using (EventWaitHandle activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, activateName, out activateCreated, eventSec))
                using (EventWaitHandle quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, quitName, out quitCreated, eventSec))
                {
                    Application.Run(new TrayApplicationContext(options, activateEvent, quitEvent));
                }

                try
                {
                    singleInstance.ReleaseMutex();
                }
                catch
                {
                }
            }

            return 0;
        }
    }
}
