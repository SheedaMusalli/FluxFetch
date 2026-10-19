using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// Native Messaging framing is binary on stdin/stdout. Never log to stdout.
class Program {
  static string FindApp(string root) {
    string bundled = Path.GetFullPath(Path.Combine(root, "..", "..", "fluxfetch.exe"));
    if (File.Exists(bundled)) return bundled;
    // A per-user helper repair can coexist with an all-users application install.
    // Resolve only FluxFetch's registered executable; never execute a shell command.
    foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
      using (RegistryKey key = hive.OpenSubKey(@"Software\Classes\Applications\fluxfetch.exe\shell\open\command")) {
        string command = key == null ? null : key.GetValue("") as string;
        if (String.IsNullOrEmpty(command) || command[0] != '"') continue;
        int end = command.IndexOf('"', 1);
        if (end < 2) continue;
        string candidate = command.Substring(1, end - 1);
        if (Path.IsPathRooted(candidate) &&
            String.Equals(Path.GetFileName(candidate), "fluxfetch.exe", StringComparison.OrdinalIgnoreCase) &&
            File.Exists(candidate)) return candidate;
      }
    }
    throw new FileNotFoundException("The FluxFetch application is not installed.");
  }
  static byte[] ReadExactly(Stream stream, int count) {
    byte[] bytes = new byte[count]; int offset = 0;
    while (offset < count) { int n = stream.Read(bytes, offset, count - offset); if (n == 0) throw new EndOfStreamException(); offset += n; }
    return bytes;
  }
  static int Main(string[] args) {
    try {
      string root = AppDomain.CurrentDomain.BaseDirectory;
      string expected = File.ReadAllText(Path.Combine(root, "extension-id.txt")).Trim();
      // Windows Chromium also supplies --parent-window (0 for service workers).
      // Keep the exact origin allowlist while accepting that documented argument.
      ulong parentWindow;
      bool hasParentWindow = args.Length == 2 &&
        args[1].StartsWith("--parent-window=", StringComparison.Ordinal) &&
        UInt64.TryParse(args[1].Substring("--parent-window=".Length), out parentWindow);
      bool chromium = (args.Length == 1 || hasParentWindow) &&
        args[0] == "chrome-extension://" + expected + "/";
      // Firefox passes the native manifest path and add-on ID; Chromium passes its origin.
      bool firefox = args.Length == 2 && args[1] == "fluxfetch@fluxfetch.app" &&
        String.Equals(Path.GetFileName(args[0]), "com.fluxfetch.browser.firefox.json", StringComparison.OrdinalIgnoreCase);
      if (!chromium && !firefox) return 2;
      Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
      int length = BitConverter.ToInt32(ReadExactly(input, 4), 0);
      if (length < 2 || length > 512 * 1024) return 3;
      string message = Encoding.UTF8.GetString(ReadExactly(input, length));
      var json = new JavaScriptSerializer();
      // Parsing rejects raw newline injection into the local line protocol.
      message = json.Serialize(json.DeserializeObject(message));
      string suffix;
      using (SHA256 hash = SHA256.Create()) {
        suffix = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).ToLowerInvariant()))).Replace("-", "").ToLowerInvariant().Substring(0, 16);
      }
      #if FLUXFETCH_TEST_HOST
      // Only the separately compiled test executable can select a test pipe.
      suffix = Environment.GetEnvironmentVariable("FLUXFETCH_TEST_PIPE");
      if (String.IsNullOrEmpty(suffix)) throw new Exception("Test pipe not set");
      #endif
      string response;
      using (var pipe = new NamedPipeClientStream(".", "fluxfetch-browser-" + suffix, PipeDirection.InOut, PipeOptions.Asynchronous)) {
        try { pipe.Connect(250); }
        catch (TimeoutException) {
          #if FLUXFETCH_TEST_HOST
          throw;
          #else
          string exe = FindApp(root);
          Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(exe) });
          pipe.Connect(20000);
          #endif
        }
        byte[] payload = Encoding.UTF8.GetBytes(message + "\n");
        pipe.Write(payload, 0, payload.Length); pipe.Flush();
        var reader = new StreamReader(pipe, Encoding.UTF8);
        var read = reader.ReadLineAsync();
        if (!read.Wait(40000)) throw new TimeoutException("FluxFetch did not respond");
        response = read.Result;
      }
      if (response == null) throw new IOException("FluxFetch disconnected");
      Reply(output, response);
      return 0;
    } catch (Exception) {
      Reply(Console.OpenStandardOutput(), "{\"ok\":false,\"error\":\"Cannot connect to FluxFetch. Install or open the Windows app and retry.\"}");
      return 1;
    }
  }
  static void Reply(Stream output, string message) {
    byte[] bytes = Encoding.UTF8.GetBytes(message);
    if (bytes.Length > 1024 * 1024) bytes = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"Response too large\"}");
    output.Write(BitConverter.GetBytes(bytes.Length), 0, 4); output.Write(bytes, 0, bytes.Length); output.Flush();
  }
}
