using System.Runtime.InteropServices;
using Windows.Graphics.Imaging;

namespace TunaOS.MediaWriter.App.Smoke;

/// <summary>
/// Saves a PNG of a top-level window for the UI smoke. PrintWindow with
/// PW_RENDERFULLCONTENT captures WinUI's composition content (including an open
/// ContentDialog) even when the window is covered; if that yields a blank image the
/// screen pixels under the window are copied instead.
/// </summary>
internal static class WindowCapture
{
    private const uint PwRenderFullContent = 0x2;
    private const uint SrcCopy = 0x00CC0020;
    private const uint CaptureBlt = 0x40000000;
    private const int DwmwaExtendedFrameBounds = 9;

    public static async Task<string> SaveAsync(IntPtr hwnd, string path)
    {
        if (!GetWindowRect(hwnd, out var rect))
        {
            throw new InvalidOperationException("GetWindowRect failed");
        }

        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        var pixels = Grab(hwnd, rect, width, height, fromScreen: false);
        var method = "PrintWindow";
        if (IsBlank(pixels))
        {
            SetForegroundWindow(hwnd);
            await Task.Delay(300);
            pixels = Grab(hwnd, rect, width, height, fromScreen: true);
            method = "screen";
        }

        // GDI leaves alpha undefined; force opaque.
        for (var i = 3; i < pixels.Length; i += 4)
        {
            pixels[i] = 255;
        }

        // The window rect includes the invisible resize borders; keep only the visible frame.
        var crop = rect;
        if (DwmGetWindowAttribute(hwnd, DwmwaExtendedFrameBounds, out var frame, Marshal.SizeOf<Rect>()) == 0)
        {
            crop = new Rect
            {
                Left = Math.Max(frame.Left, rect.Left),
                Top = Math.Max(frame.Top, rect.Top),
                Right = Math.Min(frame.Right, rect.Right),
                Bottom = Math.Min(frame.Bottom, rect.Bottom),
            };
        }

        var cropWidth = crop.Right - crop.Left;
        var cropHeight = crop.Bottom - crop.Top;
        var cropped = new byte[cropWidth * cropHeight * 4];
        for (var y = 0; y < cropHeight; y++)
        {
            Buffer.BlockCopy(
                pixels,
                (((y + crop.Top - rect.Top) * width) + (crop.Left - rect.Left)) * 4,
                cropped,
                y * cropWidth * 4,
                cropWidth * 4);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await using (var file = File.Create(path))
        {
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, file.AsRandomAccessStream());
            encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, (uint)cropWidth, (uint)cropHeight, 96, 96, cropped);
            await encoder.FlushAsync();
        }

        return method;
    }

    private static byte[] Grab(IntPtr hwnd, Rect rect, int width, int height, bool fromScreen)
    {
        var screen = GetDC(IntPtr.Zero);
        var memory = CreateCompatibleDC(screen);
        var bitmap = CreateCompatibleBitmap(screen, width, height);
        var old = SelectObject(memory, bitmap);
        try
        {
            if (fromScreen)
            {
                BitBlt(memory, 0, 0, width, height, screen, rect.Left, rect.Top, SrcCopy | CaptureBlt);
            }
            else
            {
                PrintWindow(hwnd, memory, PwRenderFullContent);
            }

            var info = new BitmapInfoHeader
            {
                Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(),
                Width = width,
                Height = -height, // top-down rows
                Planes = 1,
                BitCount = 32,
                Compression = 0, // BI_RGB
            };
            var pixels = new byte[width * height * 4];
            SelectObject(memory, old);
            if (GetDIBits(memory, bitmap, 0, (uint)height, pixels, ref info, 0) == 0)
            {
                throw new InvalidOperationException("GetDIBits failed");
            }

            return pixels;
        }
        finally
        {
            DeleteObject(bitmap);
            DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    private static bool IsBlank(byte[] bgra)
    {
        var first = BitConverter.ToInt32(bgra, 0) & 0x00FFFFFF;
        for (var i = 0; i < bgra.Length; i += 4 * 97)
        {
            if ((BitConverter.ToInt32(bgra, i) & 0x00FFFFFF) != first)
            {
                return false;
            }
        }

        return true;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width;
        public int Height;
        public ushort Planes;
        public ushort BitCount;
        public uint Compression;
        public uint SizeImage;
        public int XPelsPerMeter;
        public int YPelsPerMeter;
        public uint ClrUsed;
        public uint ClrImportant;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr src, int srcX, int srcY, uint rop);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(IntPtr hdc, IntPtr bitmap, uint start, uint lines, byte[] bits, ref BitmapInfoHeader info, uint usage);
}
