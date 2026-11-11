using System;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Windows.UI.Composition;
using Windows.Graphics.Effects;
using CompositionTarget = Windows.UI.Composition.CompositionTarget;

namespace LocalTokenWidget
{
    // The backdrop brush samples DWM's live backdrop. No screen capture, cached
    // wallpaper, or periodic hide/capture/show cycle is used.
    internal sealed class CompositionBackdrop
    {
        private static object dispatcherQueue;
        private Compositor compositor;
        private CompositionTarget target;
        private SpriteVisual glass;
        private CompositionRoundedRectangleGeometry outline;
        private HwndSource source;
        private Widget widget;
        internal bool Ready { get; private set; }
        internal string Error { get; private set; }

        internal void Prepare(Widget widget)
        {
            this.widget = widget;
            try
            {
                HwndSourceParameters parameters = new HwndSourceParameters("Token glass backdrop");
                parameters.WindowStyle = unchecked((int)0x80000000); // WS_POPUP; no native frame or shadow
                parameters.ExtendedWindowStyle = 0x80 | 0x20 | 0x8000000 | 0x200000;
                parameters.Width = 1; parameters.Height = 1;
                source = new HwndSource(parameters);
                source.CompositionTarget.BackgroundColor = Colors.Transparent;
                source.AddHook(delegate(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled) {
                    if (message == 0x84) { handled = true; return new IntPtr(-1); }
                    return IntPtr.Zero;
                });
                EnsureDispatcherQueue();
                compositor = new Compositor();
                IntPtr raw;
                ((ICompositorDesktopInterop)(object)compositor).CreateDesktopWindowTarget(source.Handle, false, out raw);
                try { target = (CompositionTarget)Marshal.GetObjectForIUnknown(raw); }
                finally { Marshal.Release(raw); }
                glass = compositor.CreateSpriteVisual();
                var effect = new BackdropBlurEffect { Source = new CompositionEffectSourceParameter("Backdrop") };
                using (CompositionEffectFactory factory = compositor.CreateEffectFactory(effect))
                {
                    CompositionEffectBrush brush = factory.CreateBrush();
                    brush.SetSourceParameter("Backdrop", compositor.CreateBackdropBrush());
                    glass.Brush = brush;
                }
                outline = compositor.CreateRoundedRectangleGeometry();
                glass.Clip = compositor.CreateGeometricClip(outline);
                target.Root = glass;
                Ready = true;
                new WindowInteropHelper(widget).Owner = source.Handle;
                Follow(widget);
            }
            catch (Exception error) { Error = error.ToString(); Ready = false; Close(); }
        }

        internal void Follow(Widget widget)
        {
            if (!Ready) return;
            IntPtr main = new WindowInteropHelper(widget).Handle;
            HwndSource mainSource = HwndSource.FromHwnd(main);
            if (mainSource == null || mainSource.CompositionTarget == null) return;
            Matrix scale = mainSource.CompositionTarget.TransformToDevice;
            NativeRect bounds;
            if (!GetWindowRect(main, out bounds)) return;
            int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
            SetWindowPos(source.Handle, main, bounds.Left, bounds.Top, width, height, 0x10 | 0x200);
            Vector2 size = new Vector2(width, height);
            glass.Size = size; outline.Size = size;
            float radius = (float)(Math.Min(20, widget.Height / 2) * scale.M11);
            outline.CornerRadius = new Vector2(radius, radius);
        }

        internal void Show() { if (Ready) { Follow(widget); ShowWindow(source.Handle, 4); } }
        internal void Hide() { if (source != null) ShowWindow(source.Handle, 0); }
        internal void Close()
        {
            if (target != null) { target.Dispose(); target = null; }
            if (compositor != null) { compositor.Dispose(); compositor = null; }
            if (source != null) { source.Dispose(); source = null; }
        }

        private static void EnsureDispatcherQueue()
        {
            if (dispatcherQueue != null) return;
            IntPtr raw;
            Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(new QueueOptions { Size = 12, ThreadType = 2, ApartmentType = 2 }, out raw));
            try { dispatcherQueue = Marshal.GetObjectForIUnknown(raw); }
            finally { Marshal.Release(raw); }
        }

        internal static void ValidateMaterial()
        {
            EnsureDispatcherQueue();
            using (Compositor testCompositor = new Compositor())
            using (CompositionEffectFactory factory = testCompositor.CreateEffectFactory(new BackdropBlurEffect { Name = "Blur", Source = new CompositionEffectSourceParameter("Backdrop") }))
            using (CompositionEffectBrush brush = factory.CreateBrush()) { }
        }

        [StructLayout(LayoutKind.Sequential)] private struct QueueOptions { public int Size, ThreadType, ApartmentType; }
        [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("CoreMessaging.dll")] private static extern int CreateDispatcherQueueController(QueueOptions options, out IntPtr controller);
        [ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ICompositorDesktopInterop
        {
            void CreateDesktopWindowTarget(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool isTopmost, out IntPtr target);
        }
    }

    // Direct2D's standard Gaussian effect, exposed to the compositor without
    // a Win2D dependency. The properties follow the documented D2D ABI.
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class BackdropBlurEffect : IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop
    {
        public string Name { get; set; }
        public BackdropBlurEffect() { Name = "Blur"; }
        internal IGraphicsEffectSource Source;
        public void GetEffectId(out Guid id) { id = new Guid("1FEB6D69-2FE6-4AC9-8C58-1D7F93E7A6A5"); }
        public void GetNamedPropertyMapping(string name, out uint index, out uint mapping)
        {
            mapping = 0;
            if (name == "BlurAmount") index = 0;
            else if (name == "Optimization") index = 1;
            else if (name == "BorderMode") index = 2;
            else throw new ArgumentException("Unknown blur property.");
        }
        public void GetPropertyCount(out uint count) { count = 3; }
        public void GetProperty(uint index, out IntPtr value)
        {
            IntPtr boxed;
            // Keep the actual IPropertyValue ABI pointer: the .NET WinRT
            // projection otherwise unboxes this into a managed float/uint.
            if (index == 0) BoxFactory.CreateSingle(12.0f, out boxed);
            else if (index == 1 || index == 2) BoxFactory.CreateUInt32(1, out boxed);
            else throw new ArgumentOutOfRangeException("index");
            Guid propertyId = new Guid("4BD682DD-7554-40E9-9A9B-82654EDE7E62");
            try { Marshal.ThrowExceptionForHR(Marshal.QueryInterface(boxed, ref propertyId, out value)); }
            finally { Marshal.Release(boxed); }
        }
        public void GetSource(uint index, out IGraphicsEffectSource source)
        {
            if (index != 0) throw new ArgumentOutOfRangeException("index");
            source = Source;
        }
        public void GetSourceCount(out uint count) { count = 1; }

        private static IPropertyValueStatics boxFactory;
        private static IPropertyValueStatics BoxFactory
        {
            get
            {
                if (boxFactory == null)
                {
                    Guid id = typeof(IPropertyValueStatics).GUID;
                    Marshal.ThrowExceptionForHR(RoGetActivationFactory("Windows.Foundation.PropertyValue", ref id, out boxFactory));
                }
                return boxFactory;
            }
        }
        [DllImport("combase.dll")] private static extern int RoGetActivationFactory([MarshalAs(UnmanagedType.HString)] string name, ref Guid id, out IPropertyValueStatics factory);
        [ComImport, Guid("629BDBC8-D932-4FF4-96B9-8D96C5C1E858"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
        private interface IPropertyValueStatics
        {
            void CreateEmpty(out IntPtr value);
            void CreateUInt8(byte input, out IntPtr value);
            void CreateInt16(short input, out IntPtr value);
            void CreateUInt16(ushort input, out IntPtr value);
            void CreateInt32(int input, out IntPtr value);
            void CreateUInt32(uint input, out IntPtr value);
            void CreateInt64(long input, out IntPtr value);
            void CreateUInt64(ulong input, out IntPtr value);
            void CreateSingle(float input, out IntPtr value);
        }
    }

    [ComImport, ComVisible(true), Guid("2FC57384-A068-44D7-A331-30982FCF7177"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IGraphicsEffectD2D1Interop
    {
        void GetEffectId(out Guid id);
        void GetNamedPropertyMapping([MarshalAs(UnmanagedType.LPWStr)] string name, out uint index, out uint mapping);
        void GetPropertyCount(out uint count);
        void GetProperty(uint index, out IntPtr value);
        void GetSource(uint index, out IGraphicsEffectSource source);
        void GetSourceCount(out uint count);
    }
}
