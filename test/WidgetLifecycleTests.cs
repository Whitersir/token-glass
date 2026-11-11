using System;

namespace LocalTokenWidget
{
    internal static class WidgetLifecycleTests
    {
        private static int assertions;
        private static void Check(bool value, string message)
        {
            if (!value) throw new Exception(message);
            assertions++;
        }

        [STAThread]
        public static int Main(string[] args)
        {
            try
            {
                CompanionVisibility state = new CompanionVisibility();
                string[] closed = new string[0];
                string[] original = { "100:200" };
                Check(!state.ShouldShow(closed), "Wait while the host has no window.");
                Check(state.ShouldShow(original), "Show when the host opens.");
                state.Hide(original);
                Check(!state.ShouldShow(original), "Keep a manually closed bar hidden on later ticks.");
                Check(!state.ShouldShow(new[] { "100:200", "100:201" }), "Opening an extra window must not cancel a close.");
                Check(state.ShouldShow(new[] { "101:300" }), "Restore after a fast process restart without an intervening closed tick.");
                state.Hide(new[] { "101:300" });
                Check(state.ShouldShow(new[] { "101:301" }), "Restore when the host reopens a window in the same process.");
                state.Hide(original);
                Check(!state.ShouldShow(closed) && !state.IsSuppressed, "Clear the close when all host windows close.");
                Check(state.ShouldShow(original), "Restore on a normal reopen.");
                state.Hide(new[] { "100:200", "100:201" });
                Check(!state.ShouldShow(new[] { "100:201" }), "Stay hidden while an original host window remains.");
                state.Show();
                Check(state.ShouldShow(new[] { "100:201" }), "An explicit show must override a manual close.");
                bool skipComposition = Array.IndexOf(args, "--skip-composition") >= 0;
                if (!skipComposition) CompositionBackdrop.ValidateMaterial();
                Console.WriteLine("Passed {0} widget lifecycle assertions; compositor check {1}.", assertions, skipComposition ? "skipped (headless mode)" : "passed");
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
    }
}
