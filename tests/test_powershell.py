"""Launcher regressions; run with python3 -m unittest discover -s tests -v.

No server is started. PowerShell runtime checks run when pwsh/powershell is on
PATH. Set JAVA_HOME to a JDK 21+ to include the full Java compilation check.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("code_mcp", ROOT / "code_mcp.py")
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class PowerShellLaunchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.work = Path(cls.temp.name)
        cls.launchers = {"python": cls.python_command}
        bun = shutil.which("bun")
        if bun:
            # The monolithic TS entrypoint starts a server on import. Evaluate
            # its actual wrapper in isolation, without executing that entrypoint.
            source = (ROOT / "code-mcp.ts").read_text()
            start = source.index("function pwshCmd(")
            end = source.index("\n}", start) + 2
            script = cls.work / "wrapper.ts"
            script.write_text('const POWERSHELL_BIN = "pwsh";\n' + source[start:end]
                              + '\nconsole.log(JSON.stringify(pwshCmd(process.argv[2])));\n')
            cls.launchers["typescript"] = lambda command: json.loads(subprocess.check_output(
                [bun, str(script), command], text=True))
        java_home = os.environ.get("JAVA_HOME", "")
        javac = str(Path(java_home) / "bin/javac") if java_home else shutil.which("javac")
        java = str(Path(java_home) / "bin/java") if java_home else shutil.which("java")
        if javac and subprocess.run([javac, "-version"], capture_output=True).returncode == 0:
            helper = cls.work / "PowerShellCommand.java"
            helper.write_text('''import java.util.Base64;
import java.nio.charset.StandardCharsets;
public class PowerShellCommand {
  public static void main(String[] args) throws Exception {
    var method = CodeMCP.class.getDeclaredMethod("pwshCmd", String.class);
    method.setAccessible(true);
    for (String arg : (String[]) method.invoke(null, args[0]))
      System.out.println(Base64.getEncoder().encodeToString(arg.getBytes(StandardCharsets.UTF_8)));
  }
}
''')
            subprocess.run([javac, "-d", str(cls.work), str(ROOT / "CodeMCP.java"), str(helper)], check=True)
            cls.launchers["java"] = lambda command: [base64.b64decode(line).decode()
                for line in subprocess.check_output([java, "-cp", str(cls.work),
                                                     "PowerShellCommand", command], text=True).splitlines()]
        cls.powershell = shutil.which("pwsh") or shutil.which("powershell")

    @staticmethod
    def python_command(command):
        with patch.object(module, "get_powershell_binary", return_value="pwsh"), \
                patch.object(module, "_run_proc", side_effect=lambda argv, *args, **kwargs: argv):
            return module.execute_powershell(command)

    def test_noninteractive_text_transport_preserves_encoded_script(self):
        # Missing text output allows Windows PowerShell to serialize stderr as
        # CLIXML. Loss of encoding breaks quoted pipes and non-ASCII commands.
        command = 'Write-Output "NAME=Tiếng Việt 😀|PLAT=windows"; Write-Output \'O\'\'Brien\'\n# trailing comment'
        for name, launcher in self.launchers.items():
            with self.subTest(implementation=name):
                argv = launcher(command)
                self.assertIn("-NoProfile", argv)
                self.assertIn("-NonInteractive", argv)
                self.assertEqual(argv[argv.index("-OutputFormat") + 1].lower(), "text")
                script = base64.b64decode(argv[argv.index("-EncodedCommand") + 1]).decode("utf-16-le")
                self.assertIn("$ProgressPreference", script)
                self.assertIn("SilentlyContinue", script)
                # Parse the supplied script separately so param/using remain
                # legal at its beginning despite the progress preference setup.
                self.assertIn("[scriptblock]::Create(", script)
                self.assertIn("FromBase64String('", script)
                payload = script.split("FromBase64String('", 1)[1].split("'", 1)[0]
                inner = base64.b64decode(payload).decode("utf-16-le")
                self.assertEqual(inner, command + "\nif (-not $?) { exit 1 }")


    def test_real_powershell_progress_errors_and_exit_status(self):
        if not self.powershell:
            self.skipTest("PowerShell unavailable; Windows 5.1 integration still required")
        cases = [
            ('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); '
             'Write-Progress -Activity "Preparing modules" -Status "loading"; '
             'Write-Output "NAME=Tiếng Việt 😀|PLAT=windows"', 0, "NAME=Tiếng Việt 😀|PLAT=windows", False),
            ("param([string]$name='O''Brien'); Write-Output $name", 0, "O'Brien", False),
            ('using namespace System.Text\n[StringBuilder]::new("using-ok").ToString()', 0, "using-ok", False),
            ("Write-Output 'O''Brien'\n# trailing comment", 0, "O'Brien", False),
            ('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Write-Output "O’Brien"', 0, "O’Brien", False),
            ('Write-Error "real-error"; exit 23', 23, "real-error", True),
            ('throw "terminating-error"', 1, "terminating-error", True),
            ('Write-Error "nonterminating-error"', 1, "nonterminating-error", True),
        ]
        if os.name == "nt":
            cases.append(('& $env:ComSpec /c "exit 7"', 1, "", False))
        for name, launcher in self.launchers.items():
            for command, code, expected, error in cases:
                with self.subTest(implementation=name, command=command):
                    argv = launcher(command)
                    argv[0] = self.powershell
                    result = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", timeout=30)
                    self.assertEqual(result.returncode, code, result)
                    self.assertIn(expected, result.stderr if error else result.stdout)
                    # Windows PowerShell 5.1 may still serialize actual errors;
                    # retain them. Successful commands must have clean output.
                    if not error:
                        self.assertNotIn("#< CLIXML", result.stdout + result.stderr)
                    self.assertNotIn("Preparing modules", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
