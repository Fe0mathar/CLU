using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

public static partial class Protocol
{
    private static void ReadProductionProof(Request r, object suppliedEnvironment)
    {
        var parent = Path.GetDirectoryName(r.requestPath);
        var requests = parent == null ? null : Path.GetDirectoryName(parent);
        var scratch = requests == null ? null : Path.GetDirectoryName(requests);
        Check(scratch != null && Same(Path.GetFileName(r.requestPath), "request.json") &&
            MatchesTemporaryName(Path.GetFileName(parent), "request-") &&
            Same(Path.GetDirectoryName(scratch), CanonicalPath(MxcPin.QualificationTempRoot, true)),
            "Production request is outside the pinned scratch layout.");

        Check(Same(r.command, CanonicalPath(MxcPin.QualificationNodeExe, false)),
            "Unexpected production Node executable.");
        VerifyProductionImage(r.command, MxcPin.QualificationNodeSha256, 128L * 1024 * 1024);
        r.productionPrivateDirectory = CanonicalPath(requests, true);

        if (Same(Path.GetFileName(requests), "private") &&
            MatchesTemporaryName(Path.GetFileName(scratch), "clue-supervisor-qualify-"))
        {
            Check(r.timeoutMs == 5000 || r.timeoutMs == 12000, "Invalid qualification timeout.");
            EnsureQualificationFixture(r);
            r.env = ReadEnvironment(r, suppliedEnvironment);
            EnsureQualificationCommand(r);
            Check(r.wfpMode == null, "Legacy WFP control requires the diagnostic image.");
            r.productionWorkspace = CanonicalPath(Path.Combine(r.fixtureRoot, "workspace"), true);
        }
        else
        {
            Check(Same(Path.GetFileName(requests), "requests") &&
                MatchesTemporaryName(Path.GetFileName(scratch), "clue-exec-"),
                "Unexpected production request directory.");
            r.fixtureRoot = CanonicalPath(scratch, true);
            var childTemp = CanonicalPath(Path.Combine(r.fixtureRoot, "temp"), true);
            var childHome = CanonicalPath(Path.Combine(r.fixtureRoot, "home"), true);
            bool candidate = ContainsExact(r.cwd, r.writableRoots);
            r.env = ReadProductionEnvironment(r, suppliedEnvironment, childTemp, childHome, candidate);
            ReadProductionCommand(r, candidate);
            r.productionWorkspace = childTemp;
        }

        r.productionProof = true;
        r.integratedWfp = true;
        r.wfpContainerId = "sandbox-" + Guid.NewGuid().ToString("N").Substring(0, 16);
        r.productionGateDirectory = LocalPath(Path.Combine(r.productionWorkspace,
            "clue-wfp-" + Guid.NewGuid().ToString("N")), true, true);
    }

    private static IDictionary<string, string> ReadProductionEnvironment(Request r, object environment,
        string childTemp, string childHome, bool candidate)
    {
        var nodeRoot = Path.GetDirectoryName(r.command);
        var systemDirectory = CanonicalPath(Environment.SystemDirectory, true);
        r.systemRoot = CanonicalPath(Path.GetDirectoryName(systemDirectory), true);
        Check(ContainsExact(nodeRoot, r.readOnlyRoots) && ContainsExact(r.systemRoot, r.readOnlyRoots) &&
            ContainsExact(childTemp, r.writableRoots) && ContainsExact(childHome, r.writableRoots) &&
            r.writableRoots.Length == (candidate ? 4 : 3) &&
            (candidate || ContainsExact(r.cwd, r.readOnlyRoots)), "Unexpected production proof roots.");

        foreach (var root in r.writableRoots)
            if (!Same(root, childTemp) && !Same(root, childHome))
                Check(!Overlaps(root, r.fixtureRoot), "Production work roots overlap private scratch.");

        var search = new List<string> { nodeRoot, systemDirectory };
        var toolRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { nodeRoot, r.systemRoot };
        var npmRoot = Path.Combine(nodeRoot, "node_modules", "npm");
        if (ContainsExact(npmRoot, r.readOnlyRoots))
            toolRoots.Add(CanonicalPath(npmRoot, true));
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!String.IsNullOrEmpty(programFiles))
        {
            AddProductionSearchRoot(r, Path.Combine(programFiles, "Git"), "cmd", "git.exe", search, toolRoots);
            AddProductionSearchRoot(r, Path.Combine(programFiles, "PowerShell", "7"), "", "pwsh.exe", search, toolRoots);
        }

        int projectRoots = 0;
        foreach (var root in r.readOnlyRoots)
        {
            if (toolRoots.Contains(root) || (!candidate && Same(root, r.cwd)))
                continue;
            Check(++projectRoots <= 1 && !Overlaps(root, r.fixtureRoot) && !Overlaps(root, r.systemRoot) &&
                !Overlaps(root, nodeRoot) && (String.IsNullOrEmpty(programFiles) || !Overlaps(root, programFiles)),
                "Unexpected production read-only root.");
        }
        foreach (var root in r.writableRoots)
            Check(String.IsNullOrEmpty(programFiles) || !Overlaps(root, programFiles),
                "Production writable root overlaps the protected installation.");
        Check(!Overlaps(r.cwd, r.fixtureRoot) && !Overlaps(r.cwd, r.systemRoot) && !Overlaps(r.cwd, nodeRoot) &&
            (String.IsNullOrEmpty(programFiles) || !Overlaps(r.cwd, programFiles)), "Unexpected production working directory.");

        var cache = LocalPath(Path.Combine(childHome, "npm-cache"), true, true);
        var userConfig = Path.Combine(childHome, "user.npmrc");
        var globalConfig = Path.Combine(childHome, "global.npmrc");
        Check(IsSyntheticFile(userConfig, "") && IsSyntheticFile(globalConfig, ""),
            "Production npm configuration must be private and empty.");
        var paths = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "PATH", String.Join(";", search) },
            { "SystemRoot", r.systemRoot }, { "WINDIR", r.systemRoot },
            { "ComSpec", CanonicalPath(Path.Combine(systemDirectory, "cmd.exe"), false) },
            { "HOME", childHome }, { "USERPROFILE", childHome }, { "APPDATA", childHome }, { "LOCALAPPDATA", childHome },
            { "TEMP", childTemp }, { "TMP", childTemp }, { "TMPDIR", childTemp },
            { "NPM_CONFIG_CACHE", cache }, { "NPM_CONFIG_USERCONFIG", userConfig }, { "NPM_CONFIG_GLOBALCONFIG", globalConfig }
        };
        var literals = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "CI", "1" }, { "NO_COLOR", "1" }, { "PATHEXT", ".COM;.EXE;.BAT;.CMD" },
            { "NPM_CONFIG_OFFLINE", "true" }, { "NPM_CONFIG_AUDIT", "false" }, { "NPM_CONFIG_FUND", "false" },
            { "NPM_CONFIG_UPDATE_NOTIFIER", "false" }
        };
        var supplied = environment as IDictionary<string, object>;
        Check(supplied != null && supplied.Count == paths.Count + literals.Count,
            "Unexpected production environment keys.");
        var result = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in paths)
        {
            object value;
            Check(supplied.TryGetValue(entry.Key, out value) && Same(AsText(value, 32766), entry.Value),
                "Unexpected production environment path.");
            result.Add(entry.Key, entry.Value);
        }
        foreach (var entry in literals)
        {
            object value;
            Check(supplied.TryGetValue(entry.Key, out value) && AsText(value, 32766) == entry.Value,
                "Unexpected production environment value.");
            result.Add(entry.Key, entry.Value);
        }
        return result;
    }

    private static void AddProductionSearchRoot(Request r, string root, string binName, string executable,
        List<string> search, HashSet<string> toolRoots)
    {
        if (!ContainsExact(root, r.readOnlyRoots))
            return;
        root = CanonicalPath(root, true);
        var bin = binName.Length == 0 ? root : CanonicalPath(Path.Combine(root, binName), true);
        CanonicalPath(Path.Combine(bin, executable), false);
        toolRoots.Add(root);
        search.Add(bin);
    }

    private static void ReadProductionCommand(Request r, bool candidate)
    {
        Check(r.args.Length != 0 && r.args[0].Length != 0, "A production Node workload is required.");
        string first = r.args[0];
        if (first == "-e" || first == "-p")
        {
            Check(r.args.Length >= 2 && r.args[1].Length != 0, "A Node expression or script is required.");
            return;
        }
        if (first == "--test")
        {
            Check(r.args.Length == 4 && r.args[1] == "--test-reporter=tap" && r.args[2] == "--test-concurrency=1" &&
                r.args[3] == "dist/selftest/**/*.test.js",
                "Unexpected Node test invocation.");
            return;
        }

        var nodeRoot = Path.GetDirectoryName(r.command);
        var npmRoot = Path.Combine(nodeRoot, "node_modules", "npm");
        var npmCli = Path.Combine(npmRoot, "bin", "npm-cli.js");
        var script = first.Replace('/', '\\');
        if (Same(script, npmCli))
        {
            Check(candidate && ContainsExact(npmRoot, r.readOnlyRoots) &&
                ((r.args.Length == 2 && r.args[1] == "ci") ||
                (r.args.Length == 3 && r.args[1] == "run" && (r.args[2] == "typecheck" || r.args[2] == "build"))),
                "Unexpected production npm invocation.");
            r.productionNpmCli = CanonicalPath(npmCli, false);
            VerifyProductionImage(r.productionNpmCli, MxcPin.ProofAdmissionNpmCliSha256, MaxNpmCliBytes);
            return;
        }

        Check(first[0] != '-', "Unexpected production Node option.");
        var entry = CanonicalPath(Path.IsPathRooted(script) ? script : Path.Combine(r.cwd, script), false);
        string extension = Path.GetExtension(entry);
        Check((Same(extension, ".js") || Same(extension, ".cjs") || Same(extension, ".mjs")) &&
            (InRoots(entry, r.readOnlyRoots) || InRoots(entry, r.writableRoots)) &&
            !Overlaps(entry, nodeRoot) && !Overlaps(entry, r.systemRoot) && !Overlaps(entry, r.fixtureRoot),
            "Unexpected production Node entry point.");
    }

    private static void VerifyProductionImage(string path, string pin, long maximumBytes)
    {
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var sha = SHA256.Create())
        {
            Check(IsSingleLink(stream) && stream.Length > 0 && stream.Length <= maximumBytes,
                "Invalid pinned production tool file.");
            var hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            Check(hash == pin, "Production tool pin mismatch.");
        }
    }
}
