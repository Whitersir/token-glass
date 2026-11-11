using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace LocalTokenWidget
{
    public static class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
            Directory.CreateDirectory(Path.Combine(root, "data"));
            string suffix = Convert.ToBase64String(Encoding.UTF8.GetBytes(root.ToLowerInvariant())).Replace("/", "_").Replace("=", "");
            string name = "Local\\TokenWidget-" + suffix;
            if (args.Length > 0 && args[0] == "--quit")
            {
                try { using (EventWaitHandle quit = EventWaitHandle.OpenExisting(name + "-quit")) quit.Set(); } catch { }
                return;
            }
            bool created;
            using (Mutex mutex = new Mutex(true, name, out created))
            {
                if (!created)
                {
                    try { using (EventWaitHandle show = EventWaitHandle.OpenExisting(name + "-show")) show.Set(); } catch { }
                    return;
                }
                try
                {
                    Application app = new Application();
                    app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                    Companion companion = new Companion(root, app);
                    using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, name + "-show"))
                    using (EventWaitHandle quit = new EventWaitHandle(false, EventResetMode.AutoReset, name + "-quit"))
                    {
                        RegisteredWaitHandle showWait = ThreadPool.RegisterWaitForSingleObject(show, delegate { app.Dispatcher.BeginInvoke(new Action(companion.ShowRequested)); }, null, Timeout.Infinite, false);
                        RegisteredWaitHandle quitWait = ThreadPool.RegisterWaitForSingleObject(quit, delegate { app.Dispatcher.BeginInvoke(new Action(companion.Exit)); }, null, Timeout.Infinite, false);
                        companion.Start();
                        app.Run();
                        showWait.Unregister(null); quitWait.Unregister(null);
                        companion.Dispose();
                    }
                }
                catch (Exception error)
                {
                    File.AppendAllText(Path.Combine(root, "data", "widget-error.log"), DateTime.Now.ToString("s") + " " + error + Environment.NewLine);
                    MessageBox.Show("悬浮条启动失败，错误已写入 data/widget-error.log。\n" + error.Message, "Token 悬浮条");
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
    }

    // A close belongs to the windows that were open when the user closed the bar.
    // Comparing identities also catches a restart entirely between timer ticks.
    internal sealed class CompanionVisibility
    {
        private readonly HashSet<string> hiddenWindows = new HashSet<string>();
        internal bool IsSuppressed { get { return hiddenWindows.Count > 0; } }
        internal void Hide(IEnumerable<string> windows) { hiddenWindows.Clear(); hiddenWindows.UnionWith(windows); }
        internal void Show() { hiddenWindows.Clear(); }
        internal bool ShouldShow(IEnumerable<string> windows)
        {
            HashSet<string> current = new HashSet<string>(windows);
            if (!hiddenWindows.Overlaps(current)) hiddenWindows.Clear();
            return current.Count > 0 && !IsSuppressed;
        }
    }

    public sealed class Companion : IDisposable
    {
        private readonly string root;
        private readonly Application app;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly DispatcherTimer timer = new DispatcherTimer();
        private readonly Forms.NotifyIcon tray = new Forms.NotifyIcon();
        private readonly string origin;
        private readonly Widget window;
        private Process backend;
        private bool codexWasOpen;
        private readonly CompanionVisibility visibility = new CompanionVisibility();
        private string lastDiagnostics;
        private bool exiting;
        private int loading;
        private DateTime nextStart = DateTime.MinValue;
        private bool first = true;
        private bool browserEnabled = true;
        private string webSource = "";
        private bool codexOpen;
        private string EffectiveSource { get { return window.SelectedSource == "auto" ? (webSource.Length > 0 ? webSource : "codex") : window.SelectedSource; } }

        public Companion(string root, Application app)
        {
            this.root = root; this.app = app;
            int port = 7681;
            try {
                var config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "config.json"))); port = Convert.ToInt32(config["port"]);
                if (config.ContainsKey("browserBridge")) { var bridge = config["browserBridge"] as Dictionary<string, object>; if (bridge != null && bridge.ContainsKey("enabled")) browserEnabled = Convert.ToBoolean(bridge["enabled"]); }
            } catch { }
            origin = "http://127.0.0.1:" + port;
            window = new Widget(root);
            window.HideRequested += HideUntilReopened;
            window.DetailsRequested += OpenDetails;
            window.RefreshRequested += SyncNow;
            window.SourceChanged += Refresh;
            Forms.ContextMenuStrip menu = new Forms.ContextMenuStrip();
            menu.Items.Add("显示悬浮条", null, delegate { app.Dispatcher.BeginInvoke(new Action(ShowRequested)); });
            menu.Items.Add("打开详细统计", null, delegate { app.Dispatcher.BeginInvoke(new Action(OpenDetails)); });
            menu.Items.Add("连接网页统计（Chrome）", null, delegate { app.Dispatcher.BeginInvoke(new Action(OpenBrowserSetup)); });
            menu.Items.Add("重置悬浮条位置", null, delegate { app.Dispatcher.BeginInvoke(new Action(window.ResetPosition)); });
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add("关闭悬浮条（下次打开应用恢复）", null, delegate { app.Dispatcher.BeginInvoke(new Action(HideUntilReopened)); });
            menu.Items.Add("完全退出后台（停止自动跟随）", null, delegate { app.Dispatcher.BeginInvoke(new Action(Exit)); });
            tray.ContextMenuStrip = menu;
            tray.Text = "Token 悬浮条 · Codex / 网页文本估算";
            tray.Icon = MakeIcon();
            tray.DoubleClick += delegate { app.Dispatcher.BeginInvoke(new Action(ShowRequested)); };
            tray.Visible = true;
            timer.Interval = TimeSpan.FromSeconds(3);
            timer.Tick += delegate { Tick(); };
        }

        public void Start() { timer.Start(); Tick(); }

        private static Drawing.Icon MakeIcon()
        {
            using (Drawing.Bitmap bitmap = new Drawing.Bitmap(32, 32))
            using (Drawing.Graphics g = Drawing.Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Drawing.Color.Transparent);
                using (Drawing.Brush brush = new Drawing.SolidBrush(Drawing.Color.FromArgb(51, 107, 84))) g.FillEllipse(brush, 1, 1, 30, 30);
                using (Drawing.Font font = new Drawing.Font("Segoe UI", 18, Drawing.FontStyle.Bold, Drawing.GraphicsUnit.Pixel)) g.DrawString("T", font, Drawing.Brushes.White, 8, 4);
                IntPtr handle = bitmap.GetHicon();
                try { return (Drawing.Icon)Drawing.Icon.FromHandle(handle).Clone(); }
                finally { Native.DestroyIcon(handle); }
            }
        }

        private void Tick()
        {
            if (exiting) return;
            bool open = HostsAreOpen();
            if (browserEnabled) EnsureBackend();
            bool show = visibility.ShouldShow(Native.OpenWindows);
            if (!open)
            {
                window.Hide();
                if (codexWasOpen && !browserEnabled) StopOwnedBackend();
            }
            else
            {
                EnsureBackend();
                if (show && !window.IsVisible) window.Show();
                Refresh();
            }
            codexWasOpen = open;
            WriteDiagnostics(open);
            if (first)
            {
                first = false;
                if (!open) { tray.BalloonTipTitle = "Token 悬浮条已就绪"; tray.BalloonTipText = "打开 Codex 或已连接扩展的聊天网页时自动显示。"; tray.ShowBalloonTip(3500); }
            }
        }

        private void HideUntilReopened()
        {
            bool open = HostsAreOpen();
            visibility.Hide(Native.OpenWindows);
            window.SavePosition(); window.Hide();
            WriteDiagnostics(open);
        }

        private bool HostsAreOpen()
        {
            codexOpen = Native.CodexIsOpen(); webSource = "";
            if (browserEnabled && Native.ChromeIsOpen())
            {
                try
                {
                    var presence = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "data", "browser-presence.json")));
                    var pages = presence["pages"] as System.Collections.IEnumerable;
                    DateTime latest = DateTime.MinValue;
                    foreach (object item in pages)
                    {
                        var page = item as Dictionary<string, object>;
                        DateTime seen;
                        if (page == null || !DateTime.TryParse(Convert.ToString(page["lastSeen"]), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out seen)) continue;
                        double age = (DateTime.UtcNow - seen.ToUniversalTime()).TotalSeconds;
                        if (age < -5 || age > 45 || !Convert.ToBoolean(page["visible"])) continue;
                        string source = Convert.ToString(page["source"]);
                        if (source != "chatgpt-web" && source != "claude-web") continue;
                        Native.OpenWindows.Add("web:" + Convert.ToString(page["instance"]));
                        if ((!codexOpen || Convert.ToBoolean(page["active"])) && seen > latest) { webSource = source; latest = seen; }
                    }
                } catch { }
            }
            return Native.OpenWindows.Count > 0;
        }

        private void WriteDiagnostics(bool open)
        {
            try
            {
                string diagnostics = json.Serialize(new { detection = json.DeserializeObject(Native.Diagnostics), codexOpen = codexOpen, hostOpen = open, source = EffectiveSource, browserBridgeEnabled = browserEnabled, widgetVisible = window.IsVisible, waitingForReopen = visibility.IsSuppressed, widgetPid = Process.GetCurrentProcess().Id, glassRenderer = window.GlassRenderer, glassError = window.GlassError });
                if (diagnostics == lastDiagnostics) return;
                File.WriteAllText(Path.Combine(root, "data", "widget-diagnostics.json"), diagnostics, Encoding.UTF8);
                lastDiagnostics = diagnostics;
            } catch { }
        }

        private void EnsureBackend()
        {
            if (backend != null) { try { if (!backend.HasExited) return; } catch { } backend.Dispose(); backend = null; }
            if (DateTime.Now < nextStart) return;
            nextStart = DateTime.Now.AddSeconds(20);
            try
            {
                string node = "node.exe";
                string saved = Path.Combine(root, "node-path.txt");
                if (File.Exists(saved)) { string candidate = File.ReadAllText(saved).Trim().Trim('\uFEFF'); if (File.Exists(candidate)) node = candidate; }
                ProcessStartInfo info = new ProcessStartInfo(node, "\"" + Path.Combine(root, "src", "cli.js") + "\" serve");
                info.WorkingDirectory = root; info.UseShellExecute = false; info.CreateNoWindow = true;
                info.RedirectStandardOutput = true; info.RedirectStandardError = true;
                backend = new Process(); backend.StartInfo = info;
                backend.OutputDataReceived += delegate { };
                backend.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (!String.IsNullOrEmpty(e.Data)) WriteError(e.Data); };
                backend.Start(); backend.BeginOutputReadLine(); backend.BeginErrorReadLine();
            }
            catch (Exception error) { WriteError(error.Message); window.SetStatus("无法启动统计，请检查 Node 环境"); }
        }

        public void Refresh()
        {
            if (exiting || Interlocked.CompareExchange(ref loading, 1, 0) != 0) return;
            string source = EffectiveSource;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + "/api/report" + (source == "all" ? "" : "?source=" + Uri.EscapeDataString(source)));
                    request.Proxy = null; request.Timeout = 2500; request.ReadWriteTimeout = 2500;
                    using (WebResponse response = request.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                    {
                        string body = reader.ReadToEnd();
                        var report = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                        app.Dispatcher.BeginInvoke(new Action(delegate { if (!exiting && source == EffectiveSource) window.Update(report); }));
                    }
                }
                catch { app.Dispatcher.BeginInvoke(new Action(delegate { if (!exiting) window.SetStatus("正在连接本地统计…"); })); }
                finally { Interlocked.Exchange(ref loading, 0); }
            });
        }

        public void SyncNow()
        {
            window.SetStatus("正在同步…");
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + "/api/sync");
                    request.Proxy = null; request.Method = "POST"; request.ContentLength = 0; request.Timeout = 30000;
                    request.Headers["Origin"] = origin; request.Headers["X-Token-Meter"] = "local";
                    using (WebResponse response = request.GetResponse()) { }
                    app.Dispatcher.BeginInvoke(new Action(Refresh));
                }
                catch (Exception error) { WriteError(error.Message); app.Dispatcher.BeginInvoke(new Action(delegate { window.SetStatus("同步暂时失败，将自动重试"); })); }
            });
        }

        public void ShowRequested()
        {
            if (!HostsAreOpen())
            {
                tray.BalloonTipTitle = "等待应用"; tray.BalloonTipText = "打开 Codex 或已连接扩展的聊天网页后自动显示。"; tray.ShowBalloonTip(2500); return;
            }
            visibility.Show(); EnsureBackend(); window.Show(); Refresh();
            WriteDiagnostics(true);
        }

        public void OpenDetails()
        {
            EnsureBackend();
            try { Process.Start(new ProcessStartInfo(origin) { UseShellExecute = true }); } catch (Exception error) { WriteError(error.Message); }
        }

        private void OpenBrowserSetup()
        {
            EnsureBackend();
            try { Process.Start(new ProcessStartInfo(origin + "/browser.html") { UseShellExecute = true }); } catch (Exception error) { WriteError(error.Message); }
        }

        private void StopOwnedBackend()
        {
            Process owned = backend; backend = null; nextStart = DateTime.MinValue;
            if (owned == null) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    if (!owned.HasExited)
                    {
                        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + "/api/stop");
                        request.Proxy = null; request.Method = "POST"; request.ContentLength = 0; request.Timeout = 1500;
                        request.Headers["Origin"] = origin; request.Headers["X-Token-Meter"] = "local";
                        try { using (WebResponse response = request.GetResponse()) { } } catch { }
                        if (!owned.WaitForExit(2000)) owned.Kill();
                    }
                }
                catch { }
                finally { owned.Dispose(); }
            });
        }

        private void WriteError(string text)
        {
            try { File.AppendAllText(Path.Combine(root, "data", "widget-error.log"), DateTime.Now.ToString("s") + " " + text + Environment.NewLine); } catch { }
        }
        public void Exit()
        {
            if (exiting) return;
            exiting = true; timer.Stop(); window.SavePosition(); tray.Visible = false;
            StopOwnedBackend(); window.Close();
            // Allow the graceful local stop request to finish before ending the watcher.
            DispatcherTimer finish = new DispatcherTimer(); finish.Interval = TimeSpan.FromSeconds(2.5);
            finish.Tick += delegate { finish.Stop(); app.Shutdown(); }; finish.Start();
        }
        public void Dispose() { timer.Stop(); tray.Dispose(); }
    }

    public sealed class Widget : Window
    {
        private readonly string settingsFile;
        private readonly Dictionary<string, TextBlock> labels = new Dictionary<string, TextBlock>();
        private readonly FrameworkElement detail;
        private readonly Border surface;
        private readonly GlassChrome chrome;
        private readonly GlassShadow shadow;
        private readonly CompositionBackdrop backdrop;
        private bool compact;
        private bool closing;
        public event Action HideRequested, DetailsRequested, RefreshRequested, SourceChanged;
        public string SelectedSource { get; private set; }
        internal string GlassRenderer { get { return backdrop.Ready ? "composition-gaussian-blur" : "accent-fallback"; } }
        internal string GlassError { get { return backdrop.Error; } }

        public Widget(string root)
        {
            settingsFile = Path.Combine(root, "data", "widget-settings.json");
            SelectedSource = "auto";
            Title = "Codex Token 悬浮条";
            Width = 382; Height = 56; WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true; Background = Brushes.Transparent;
            ShowInTaskbar = File.Exists(Path.Combine(root, "data", "widget-preview.flag"));
            Topmost = true; ShowActivated = false; WindowStartupLocation = WindowStartupLocation.Manual;
            FontFamily = new FontFamily("Segoe UI, Microsoft YaHei UI");
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.Grayscale);
            string xaml = @"<Border xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' CornerRadius='20' Padding='14,6,11,5'>
              <Border.Resources><Style TargetType='Button'><Setter Property='FocusVisualStyle' Value='{x:Null}'/><Setter Property='Focusable' Value='False'/><Setter Property='IsTabStop' Value='False'/><Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='buttonFace' Background='Transparent' CornerRadius='4'><ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/></Border><ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='buttonFace' Property='Background' Value='#22FFFFFF'/></Trigger><Trigger Property='IsPressed' Value='True'><Setter TargetName='buttonFace' Property='Background' Value='#35FFFFFF'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style></Border.Resources>
              <Grid><Grid.ColumnDefinitions><ColumnDefinition Width='100'/><ColumnDefinition Width='1'/><ColumnDefinition Width='*'/><ColumnDefinition Width='16'/></Grid.ColumnDefinitions>
                <StackPanel Grid.Column='0' VerticalAlignment='Center'><TextBlock x:Name='todayLabel' Text='今日 Token' FontSize='8.5' Foreground='#F4FFFFFF'/><TextBlock x:Name='total' Text='—' FontSize='21' FontWeight='SemiBold' Foreground='White' Margin='0,-2,0,-2'/><TextBlock x:Name='date' FontSize='7.8' Foreground='#F4FFFFFF'/></StackPanel>
                <Border Grid.Column='1' Margin='0,3'><Border.Background><LinearGradientBrush StartPoint='0,0' EndPoint='0,1'><GradientStop Color='#00FFFFFF' Offset='0'/><GradientStop Color='#50FFFFFF' Offset='0.3'/><GradientStop Color='#38FFFFFF' Offset='0.8'/><GradientStop Color='#00FFFFFF' Offset='1'/></LinearGradientBrush></Border.Background></Border>
                <Grid Grid.Column='2' Margin='12,0,7,0'><Grid.RowDefinitions><RowDefinition Height='25'/><RowDefinition Height='*'/></Grid.RowDefinitions>
                  <Grid Grid.Row='0'><StackPanel Orientation='Horizontal' VerticalAlignment='Center'><TextBlock x:Name='grandTitle' Text='总共 Token' FontSize='9' Foreground='#F5FAFF' VerticalAlignment='Center' Margin='0,0,7,0'/><TextBlock x:Name='grandTotal' Text='—' FontSize='19' FontWeight='SemiBold' Foreground='White'/></StackPanel><TextBlock x:Name='status' Visibility='Collapsed'/></Grid>
                  <Grid x:Name='detail' Grid.Row='1'><Grid.ColumnDefinitions><ColumnDefinition Width='*'/><ColumnDefinition Width='*'/><ColumnDefinition Width='*'/></Grid.ColumnDefinitions>
                    <StackPanel Grid.Column='0' Orientation='Horizontal' VerticalAlignment='Center'><TextBlock Text='输入 ' FontSize='8.2' Foreground='#F2F7FF' VerticalAlignment='Center'/><TextBlock x:Name='input' Text='—' FontSize='10.5' FontWeight='SemiBold' Foreground='White'/></StackPanel>
                    <StackPanel Grid.Column='1' Orientation='Horizontal' VerticalAlignment='Center'><TextBlock Text='输出 ' FontSize='8.2' Foreground='#F2F7FF' VerticalAlignment='Center'/><TextBlock x:Name='output' Text='—' FontSize='10.5' FontWeight='SemiBold' Foreground='White'/></StackPanel>
                    <StackPanel Grid.Column='2' Orientation='Horizontal' VerticalAlignment='Center'><TextBlock Text='缓存 ' FontSize='8.2' Foreground='#F2F7FF' VerticalAlignment='Center'/><TextBlock x:Name='cache' Text='—' FontSize='10.5' FontWeight='SemiBold' Foreground='White'/></StackPanel>
                  </Grid>
                </Grid>
                <StackPanel Grid.Column='3' VerticalAlignment='Center'><Button x:Name='menu' Content='⋯' FontSize='15' Foreground='White' Background='Transparent' BorderThickness='0' Padding='0' Height='20' ToolTip='更多选项'/><Button x:Name='fold' Content='⌃' FontSize='11' Foreground='White' Background='Transparent' BorderThickness='0' Height='17' ToolTip='折叠 / 展开'/></StackPanel>
              </Grid>
            </Border>";
            surface = (Border)XamlReader.Parse(xaml);
            Grid layers = new Grid();
            chrome = new GlassChrome();
            layers.Children.Add(chrome); layers.Children.Add(surface); Content = layers;
            shadow = new GlassShadow(this);
            backdrop = new CompositionBackdrop();
            foreach (string name in new string[] { "total", "grandTotal", "grandTitle", "todayLabel", "date", "status", "input", "output", "cache" }) labels[name] = (TextBlock)surface.FindName(name);
            detail = (FrameworkElement)surface.FindName("detail");
            Button menu = (Button)surface.FindName("menu"), fold = (Button)surface.FindName("fold");
            ContextMenu context = new ContextMenu();
            AddMenu(context, "立即同步", delegate { if (RefreshRequested != null) RefreshRequested(); });
            AddMenu(context, "打开详细统计", delegate { if (DetailsRequested != null) DetailsRequested(); });
            MenuItem sourceMenu = new MenuItem { Header = "统计来源" };
            string[] sourceKeys = { "auto", "codex", "claude", "chatgpt-web", "claude-web", "all" };
            string[] sourceLabels = { "自动跟随", "Codex", "Claude Code", "ChatGPT 网页 · 文本估算", "Claude 网页 · 文本估算", "全部来源（含估算）" };
            for (int i = 0; i < sourceKeys.Length; i++)
            {
                string key = sourceKeys[i];
                MenuItem choice = new MenuItem { Header = sourceLabels[i], Tag = key, IsCheckable = true };
                choice.Click += delegate { SelectedSource = key; SavePosition(); if (SourceChanged != null) SourceChanged(); };
                sourceMenu.Items.Add(choice);
            }
            sourceMenu.SubmenuOpened += delegate { foreach (MenuItem choice in sourceMenu.Items) choice.IsChecked = Convert.ToString(choice.Tag) == SelectedSource; };
            context.Items.Add(sourceMenu);
            MenuItem pin = new MenuItem { Header = "始终置顶", IsCheckable = true, IsChecked = true };
            pin.Click += delegate { Topmost = pin.IsChecked; backdrop.Follow(this); shadow.Follow(); SavePosition(); }; context.Items.Add(pin);
            AddMenu(context, "重置位置", ResetPosition);
            context.Items.Add(new Separator());
            AddMenu(context, "关闭悬浮条（下次打开应用恢复）", delegate { if (HideRequested != null) HideRequested(); });
            ContextMenu = context;
            menu.Click += delegate { context.PlacementTarget = menu; context.IsOpen = true; };
            fold.Click += delegate { SetCompact(!compact); SavePosition(); };
            MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e)
            {
                if (menu.IsMouseOver || fold.IsMouseOver || FindButton(e.OriginalSource as DependencyObject)) return;
                if (e.ClickCount == 2) { SetCompact(!compact); SavePosition(); return; }
                try { DragMove(); ClampPosition(); SavePosition(); } catch { }
            };
            MouseMove += delegate(object sender, MouseEventArgs e) { chrome.SetLight(e.GetPosition(this)); };
            MouseLeave += delegate { chrome.SetLight(null); };
            SourceInitialized += delegate
            {
                IntPtr handle = new WindowInteropHelper(this).Handle;
                long style = Native.GetWindowLong(handle, -20).ToInt64();
                if (!ShowInTaskbar) Native.SetWindowLong(handle, -20, new IntPtr(style | 0x80));
                backdrop.Prepare(this);
                if (!backdrop.Ready) Native.EnableGlass(handle);
            };
            ContentRendered += delegate { if (!backdrop.Ready) ApplyRoundedRegion(); backdrop.Follow(this); shadow.Follow(); };
            SizeChanged += delegate { if (!backdrop.Ready) Dispatcher.BeginInvoke(DispatcherPriority.ContextIdle, new Action(ApplyRoundedRegion)); backdrop.Follow(this); shadow.Follow(); };
            LocationChanged += delegate { backdrop.Follow(this); shadow.Follow(); };
            IsVisibleChanged += delegate {
                if (IsVisible) { if (backdrop.Ready) { backdrop.Follow(this); backdrop.Show(); } shadow.Reveal(); }
                else { shadow.Hide(); backdrop.Hide(); }
            };
            Closed += delegate { shadow.Close(); backdrop.Close(); };
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (!closing) { e.Cancel = true; if (HideRequested != null) HideRequested(); } };
            SetDefaultPosition(); LoadPosition(); pin.IsChecked = Topmost;
        }

        private static bool FindButton(DependencyObject item)
        {
            while (item != null) { if (item is Button) return true; try { item = VisualTreeHelper.GetParent(item); } catch { break; } }
            return false;
        }
        private static void AddMenu(ContextMenu menu, string title, Action action) { MenuItem item = new MenuItem { Header = title }; item.Click += delegate { action(); }; menu.Items.Add(item); }
        private void SetCompact(bool value)
        {
            compact = value;
            detail.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
            labels["todayLabel"].Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
            labels["date"].Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
            Height = compact ? 38 : 56;
            chrome.Compact = compact;
            ((Button)surface.FindName("fold")).Content = compact ? "⌄" : "⌃";
            ClampPosition();
        }
        private void ApplyRoundedRegion()
        {
            IntPtr handle = new WindowInteropHelper(this).Handle;
            PresentationSource source = PresentationSource.FromVisual(this);
            if (handle == IntPtr.Zero || source == null || source.CompositionTarget == null) return;
            Matrix scale = source.CompositionTarget.TransformToDevice;
            Native.RoundWindow(handle, (int)Math.Round(Width * scale.M11), (int)Math.Round(Height * scale.M22), 0, (int)Math.Round(40 * scale.M11));
        }
        public void ResetPosition()
        {
            SetDefaultPosition(); SavePosition();
        }
        private void SetDefaultPosition()
        {
            Rect work = SystemParameters.WorkArea;
            Left = work.Right - Width - 24; Top = work.Top + 88;
            ClampPosition();
        }
        private void ClampPosition()
        {
            // Keep at least a full widget visible, including after a display disconnect.
            double left = SystemParameters.VirtualScreenLeft, top = SystemParameters.VirtualScreenTop;
            Left = Math.Max(left, Math.Min(Left, left + SystemParameters.VirtualScreenWidth - Width));
            Top = Math.Max(top, Math.Min(Top, top + SystemParameters.VirtualScreenHeight - Height));
        }
        private void LoadPosition()
        {
            try
            {
                if (!File.Exists(settingsFile)) return;
                var saved = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsFile));
                Left = Convert.ToDouble(saved["left"]); Top = Convert.ToDouble(saved["top"]);
                if (!saved.ContainsKey("appearanceVersion")) { Left += 4; Top += 4; }
                Topmost = Convert.ToBoolean(saved["topmost"]); SetCompact(Convert.ToBoolean(saved["compact"]));
                if (saved.ContainsKey("selectedSource")) {
                    string selected = Convert.ToString(saved["selectedSource"]);
                    if (Array.IndexOf(new string[] { "auto", "codex", "claude", "chatgpt-web", "claude-web", "all" }, selected) >= 0) SelectedSource = selected;
                }
            } catch { }
            ClampPosition();
        }
        public void SavePosition()
        {
            try { File.WriteAllText(settingsFile, new JavaScriptSerializer().Serialize(new { left = Left, top = Top, topmost = Topmost, compact = compact, appearanceVersion = 2, selectedSource = SelectedSource }), Encoding.UTF8); } catch { }
        }
        public new void Close() { closing = true; base.Close(); }
        public void SetStatus(string text) { labels["status"].Text = text; }
        private static string Count(double value)
        {
            if (value >= 1000000000) return (value / 1000000000).ToString("0.00", CultureInfo.InvariantCulture) + "B";
            if (value >= 1000000) return (value / 1000000).ToString("0.00", CultureInfo.InvariantCulture) + "M";
            if (value >= 1000) return (value / 1000).ToString("0.0", CultureInfo.InvariantCulture) + "K";
            return value.ToString("N0");
        }
        private static double Value(Dictionary<string, object> row, string key) { return row.ContainsKey(key) ? Convert.ToDouble(row[key]) : 0; }
        private void SetCount(string name, double count) { labels[name].Text = Count(count); labels[name].ToolTip = count.ToString("N0") + " token"; }
        public void Update(Dictionary<string, object> report)
        {
            Dictionary<string, object> today = report["today"] as Dictionary<string, object>;
            if (today == null) return;
            SetCount("total", Value(today, "total")); SetCount("input", Value(today, "input"));
            Dictionary<string, object> lifetime = report.ContainsKey("lifetime") ? report["lifetime"] as Dictionary<string, object> : null;
            if (lifetime != null)
            {
                SetCount("grandTotal", Value(lifetime, "total"));
                labels["grandTotal"].ToolTip = "累计 " + Value(lifetime, "total").ToString("N0") + " token\n本机日志 " + Value(lifetime, "recordedTokens").ToString("N0") + " + 刷机前补录 " + Value(lifetime, "historicalTokens").ToString("N0");
            }
            SetCount("output", Value(today, "output")); SetCount("cache", Value(today, "cacheRead") + Value(today, "cacheWrite"));
            string measurement = report.ContainsKey("measurement") ? Convert.ToString(report["measurement"]) : "usage";
            string sourceLabel = report.ContainsKey("sourceLabel") ? Convert.ToString(report["sourceLabel"]) : "Codex";
            labels["todayLabel"].Text = measurement == "visible-text" ? "今日文本估算" : "今日 Token";
            labels["grandTitle"].Text = sourceLabel == "Codex" ? "总共 Token" : sourceLabel.Replace(" 网页", "");
            if (Value(today, "estimatedTokens") > 0 || measurement == "visible-text") labels["total"].Text = "≈" + labels["total"].Text;
            if (lifetime != null && (Value(lifetime, "estimatedTokens") > 0 || measurement == "visible-text")) labels["grandTotal"].Text = "≈" + labels["grandTotal"].Text;
            if (measurement == "visible-text") { labels["cache"].Text = "—"; labels["grandTotal"].ToolTip = "网页可见文本估算；按本机采集日归档，不代表实际消耗。"; }
            labels["output"].ToolTip = "输出 " + Value(today, "output").ToString("N0") + "，其中推理 " + Value(today, "reasoning").ToString("N0") + "（已包含）";
            string zone = Convert.ToString(report["timezone"]);
            DateTime utc = DateTime.UtcNow;
            DateTime clock = utc;
            if (zone == "Asia/Shanghai") clock = utc.AddHours(8);
            else if (zone == "UTC") clock = utc;
            else clock = DateTime.Now;
            labels["date"].Text = clock.ToString("MM月dd日 dddd", CultureInfo.GetCultureInfo("zh-CN"));
            if (report["lastSync"] == null) SetStatus("正在导入历史日志…");
            else
            {
                DateTime last = DateTime.Parse(Convert.ToString(report["lastSync"]), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToLocalTime();
                SetStatus("本地统计 · " + last.ToString("HH:mm:ss"));
            }
            surface.ToolTip = sourceLabel + " · " + labels["status"].Text + (measurement == "usage" ? "" : "\n含网页可见文本估算；不含上下文重复发送、隐藏推理、图片和缓存。") + "\n拖动移动；双击折叠；右键切换统计来源";
        }
    }

    // Live DWM backdrop underneath, optical coatings above. Text is on a
    // separate layer, so neither the blur nor the sheen softens the numbers.
    internal sealed class GlassChrome : FrameworkElement
    {
        private bool compact;
        private Point? light;
        internal bool Compact { set { compact = value; InvalidateVisual(); } }
        internal GlassChrome() { IsHitTestVisible = false; }
        internal void SetLight(Point? value) { light = value; InvalidateVisual(); }

        private static LinearGradientBrush Gradient(params Color[] colors)
        {
            LinearGradientBrush brush = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0, 1) };
            for (int i = 0; i < colors.Length; i++) brush.GradientStops.Add(new GradientStop(colors[i], (double)i / (colors.Length - 1)));
            brush.Freeze(); return brush;
        }
        private static Color White(byte alpha) { return Color.FromArgb(alpha, 255, 255, 255); }
        protected override void OnRender(DrawingContext dc)
        {
            base.OnRender(dc);
            if (ActualWidth < 4 || ActualHeight < 4) return;
            double radius = Math.Min(20, ActualHeight / 2);
            Rect body = new Rect(0.5, 0.5, ActualWidth - 1, ActualHeight - 1);
            RectangleGeometry shape = new RectangleGeometry(body, radius, radius);
            dc.PushClip(shape);
            // A neutral cool tint, rather than an opaque blue-grey panel.
            dc.DrawRectangle(new SolidColorBrush(Color.FromArgb(100, 61, 79, 101)), null, body);
            dc.DrawRectangle(Gradient(White(58), White(16), White(2), White(6), White(23)), null, body);
            RadialGradientBrush wash = new RadialGradientBrush(White(52), White(0)) {
                Center = new Point(0.12, 0.02), GradientOrigin = new Point(0.12, 0.02), RadiusX = 0.6, RadiusY = 1.8
            };
            dc.DrawRectangle(wash, null, body);
            if (!compact)
            {
                // The inset lens echoes the template's brighter clock capsule.
                dc.DrawRoundedRectangle(Gradient(White(43), White(17), White(7)), null,
                    new Rect(4, 4, 106, Math.Max(1, ActualHeight - 8)), Math.Max(1, radius - 4), Math.Max(1, radius - 4));
            }
            // Broad internal bevel plus a fine, directional specular rim.
            dc.DrawRoundedRectangle(null, new Pen(Gradient(White(78), White(9), White(5), White(38)), 2.4),
                new Rect(1.8, 1.8, ActualWidth - 3.6, ActualHeight - 3.6), radius - 1.3, radius - 1.3);
            LinearGradientBrush rim = new LinearGradientBrush { StartPoint = new Point(0.15, 0), EndPoint = new Point(0.85, 1) };
            rim.GradientStops.Add(new GradientStop(White(238), 0));
            rim.GradientStops.Add(new GradientStop(White(124), 0.3));
            rim.GradientStops.Add(new GradientStop(White(54), 0.55));
            rim.GradientStops.Add(new GradientStop(White(175), 1));
            dc.DrawRoundedRectangle(null, new Pen(rim, 0.65), body, radius, radius);
            if (light.HasValue)
            {
                Point center = new Point(light.Value.X / ActualWidth, light.Value.Y / ActualHeight);
                RadialGradientBrush reflection = new RadialGradientBrush(White(24), White(0)) {
                    Center = center, GradientOrigin = center, RadiusX = 0.3, RadiusY = 1.7
                };
                dc.DrawRectangle(reflection, null, body);
            }
            dc.Pop();
        }
    }

    // A separate alpha window lets the shadow extend beyond the rounded glass
    // HWND. Acrylic fills its HWND; padding on that HWND creates a visible box.
    internal sealed class GlassShadow : Window
    {
        private const double Halo = 22;
        private readonly Widget glass;
        private readonly ShadowDrawing drawing;

        internal GlassShadow(Widget glass)
        {
            this.glass = glass;
            drawing = new ShadowDrawing(glass, Halo);
            Title = "Token shadow";
            WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true; Background = Brushes.Transparent;
            ShowInTaskbar = false; ShowActivated = false; Focusable = false;
            IsHitTestVisible = false; WindowStartupLocation = WindowStartupLocation.Manual;
            Content = drawing;
            SourceInitialized += delegate
            {
                IntPtr handle = new WindowInteropHelper(this).Handle;
                long style = Native.GetWindowLong(handle, -20).ToInt64();
                Native.SetWindowLong(handle, -20, new IntPtr(style | 0x80 | 0x20 | 0x8000000));
                HwndSource source = HwndSource.FromHwnd(handle);
                if (source != null) source.AddHook(delegate(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
                {
                    if (message == 0x84) { handled = true; return new IntPtr(-1); }
                    return IntPtr.Zero;
                });
            };
        }
        internal void Follow()
        {
            if (Double.IsNaN(glass.Left) || Double.IsNaN(glass.Top)) return;
            Left = glass.Left - Halo; Top = glass.Top - Halo;
            Width = glass.Width + Halo * 2; Height = glass.Height + Halo * 2;
            Topmost = glass.Topmost;
            drawing.InvalidateVisual();
        }
        internal void Reveal()
        {
            Follow();
            if (Owner == null) Owner = glass;
            if (!IsVisible) Show();
        }
    }

    internal sealed class ShadowDrawing : FrameworkElement
    {
        private readonly Widget glass;
        private readonly double halo;
        internal ShadowDrawing(Widget glass, double halo) { this.glass = glass; this.halo = halo; }
        protected override void OnRender(DrawingContext dc)
        {
            base.OnRender(dc);
            if (ActualWidth <= 0 || ActualHeight <= 0) return;
            double radius = Math.Min(20, glass.Height / 2);
            // Draw only the shadow: no opaque source silhouette that can leak
            // through an opacity-mask rounding or DPI mismatch.
            Geometry outside = new CombinedGeometry(GeometryCombineMode.Exclude,
                new RectangleGeometry(new Rect(0, 0, ActualWidth, ActualHeight)),
                new RectangleGeometry(new Rect(halo - 0.5, halo - 0.5, glass.Width + 1, glass.Height + 1), radius + 0.5, radius + 0.5));
            dc.PushClip(outside);
            for (int spread = (int)halo; spread >= 1; spread--)
            {
                byte alpha = (byte)(spread < 9 ? 5 : 2);
                dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromArgb(alpha, 20, 30, 43)), null,
                    new Rect(halo - spread, halo - spread + 4, glass.Width + spread * 2, glass.Height + spread * 2), radius + spread, radius + spread);
            }
            dc.Pop();
        }
    }

    internal static class Native
    {
        internal delegate bool EnumWindowProc(IntPtr window, IntPtr param);
        [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll")] internal static extern bool DestroyIcon(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int length);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [StructLayout(LayoutKind.Sequential)] private struct AccentPolicy { public int State; public int Flags; public uint Gradient; public int Animation; }
        [StructLayout(LayoutKind.Sequential)] private struct CompositionData { public int Attribute; public IntPtr Data; public int Size; }
        [DllImport("user32.dll")] private static extern int SetWindowCompositionAttribute(IntPtr handle, ref CompositionData data);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
        [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
        internal static void EnableGlass(IntPtr window)
        {
            IntPtr buffer = IntPtr.Zero;
            try
            {
                AccentPolicy accent = new AccentPolicy { State = 3, Flags = 0, Gradient = 0x00FFFFFF };
                int size = Marshal.SizeOf(accent); buffer = Marshal.AllocHGlobal(size); Marshal.StructureToPtr(accent, buffer, false);
                CompositionData data = new CompositionData { Attribute = 19, Data = buffer, Size = size };
                SetWindowCompositionAttribute(window, ref data);
            } catch { }
            finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); }
        }
        internal static void RoundWindow(IntPtr window, int width, int height, int margin, int diameter)
        {
            IntPtr region = CreateRoundRectRgn(margin, margin, width - margin + 1, height - margin + 1, diameter, diameter);
            if (region != IntPtr.Zero && SetWindowRgn(window, region, true) == 0) DeleteObject(region);
        }
        internal static string Diagnostics = "{}";
        internal static readonly HashSet<string> OpenWindows = new HashSet<string>();
        internal static bool ChromeIsOpen()
        {
            HashSet<uint> ids = new HashSet<uint>();
            foreach (Process process in Process.GetProcessesByName("chrome")) { using (process) { ids.Add((uint)process.Id); } }
            bool found = false;
            EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
                if (!IsWindowVisible(handle)) return true;
                uint pid; GetWindowThreadProcessId(handle, out pid);
                if (!ids.Contains(pid)) return true;
                found = true; return false;
            }, IntPtr.Zero);
            return found;
        }
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] private static extern IntPtr GetWindowLongPtr64(IntPtr h, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")] private static extern IntPtr SetWindowLongPtr64(IntPtr h, int index, IntPtr value);
        [DllImport("user32.dll", EntryPoint = "GetWindowLong")] private static extern int GetWindowLong32(IntPtr h, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLong")] private static extern int SetWindowLong32(IntPtr h, int index, int value);
        internal static IntPtr GetWindowLong(IntPtr h, int i) { return IntPtr.Size == 8 ? GetWindowLongPtr64(h, i) : new IntPtr(GetWindowLong32(h, i)); }
        internal static IntPtr SetWindowLong(IntPtr h, int i, IntPtr v) { return IntPtr.Size == 8 ? SetWindowLongPtr64(h, i, v) : new IntPtr(SetWindowLong32(h, i, v.ToInt32())); }

        internal static bool CodexIsOpen()
        {
            HashSet<uint> candidates = new HashSet<uint>();
            int queried = 0;
            foreach (Process process in Process.GetProcessesByName("ChatGPT"))
            {
                using (process)
                {
                    try
                    {
                        string file = "";
                        IntPtr handle = OpenProcess(0x1000, false, process.Id);
                        if (handle != IntPtr.Zero)
                        {
                            try { StringBuilder buffer = new StringBuilder(4096); int length = buffer.Capacity; if (QueryFullProcessImageName(handle, 0, buffer, ref length)) { file = buffer.ToString(); queried++; } }
                            finally { CloseHandle(handle); }
                        }
                        if (file.IndexOf("OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0) candidates.Add((uint)process.Id);
                    } catch { }
                }
            }
            OpenWindows.Clear();
            int visible = 0;
            bool enumerated = EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                if (!IsWindowVisible(window)) return true;
                visible++;
                uint pid; GetWindowThreadProcessId(window, out pid);
                if (!candidates.Contains(pid)) return true;
                OpenWindows.Add(pid.ToString(CultureInfo.InvariantCulture) + ":" + window.ToInt64().ToString(CultureInfo.InvariantCulture));
                return true;
            }, IntPtr.Zero);
            bool found = OpenWindows.Count > 0;
            Diagnostics = new JavaScriptSerializer().Serialize(new { queriedProcesses = queried, candidateProcesses = candidates.Count, visibleWindows = visible, enumerated = enumerated, detected = found });
            return found;
        }
    }
}
