#!/usr/bin/env python3
"""Host drift check behavior, driven by declarations the test writes itself.

The check exists to fail loudly when the engine drops a prop this repository
declares, so the failure path is the behavior worth testing: a name that is gone
must be refused and named, and a check that cannot run must say so rather than
pass.

The declaration these cases feed it is a stand-in. It is not the engine, and no
case here claims the subset against the engine: what they prove is that the
check refuses the right things, and that it reads the right file. The subset
itself is measured in `EngineOnThisMachineCase`, which reads the declaration the
engine scaffolds into the plugin folder and skips, with the reason, where no
engine has written one.
"""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "host-drift.py"
DECLARED_SUBSET = ROOT / "plugins" / "fleet" / "components" / "host.ts"
SCAFFOLDED = (Path("plugins") / "fleet" / ".claude-plugin" / "types" / "claude-code"
              / "index.d.ts")


# A stand-in for the engine's declaration, shaped like it and written here.
#
# It carries the props the refusal cases remove, so the check can be shown to
# name a prop the engine stopped carrying. Nothing in this file is evidence
# about the engine, and widening an entry here to match a widening of the subset
# would prove nothing: that is what `EngineOnThisMachineCase` exists to avoid.
ENGINE = """\
export type ThemeKey = 'text' | 'inverseText' | 'subtle' | 'inactive' | 'success' | 'error' | 'warning' | 'merged' | 'claude' | 'suggestion' | 'planMode' | 'promptBorder' | 'bashBorder' | 'diffRemovedDimmed' | 'diffAddedDimmed';
export namespace Elements {
  export type BoxHoverProps = {
      scope?: string;
      borderColor?: string;
      borderDimColor?: boolean;
      backgroundColor?: string;
      display?: 'flex';
  };
  export type TextHoverProps = {
      color?: string;
      backgroundColor?: string;
      dimColor?: boolean;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      inverse?: boolean;
  };
export type BoxProps = {
      key?: string;
      hover?: BoxHoverProps;
      display?: 'flex' | 'none';
      flexDirection?: "row" | "column";
      gap?: number;
      width?: number;
      minWidth?: number;
      flexGrow?: number;
      flexShrink?: number;
      justifyContent?: "flex-start";
      alignItems?: "flex-start";
      paddingX?: number;
      paddingY?: number;
      rowGap?: number;
      columnGap?: number;
      marginTop?: number;
      marginBottom?: number;
      marginX?: number;
      marginLeft?: number;
      marginRight?: number;
      position?: 'relative' | 'absolute';
      top?: number;
      left?: number;
      borderStyle?: "round";
      borderColor?: string;
      borderDimColor?: boolean;
      backgroundColor?: string;
  };
  export type TextProps = {
      hover?: TextHoverProps;
      color?: string;
      backgroundColor?: string;
      dimColor?: boolean;
      bold?: boolean;
      italic?: boolean;
      wrap?: "wrap" | "truncate-end";
  };
  export type ButtonProps = {
      key?: string;
      label?: string;
      onPress?: () => void;
      hotkey?: string;
      dimColor?: boolean;
      plain?: true;
      variant?: "primary" | "secondary";
      hover?: TextHoverProps;
  };
  export type LinkProps = {
      href: string;
      label?: string;
  };
  export type InputProps = {
      key: string;
      label?: string;
      placeholder?: string;
      value?: string;
      submitLabel?: string;
      onSubmit: (value: string) => void;
  };
  export type SvgProps = {
      source: string;
      alt: string;
      width?: number;
      height?: number;
      isInteractive?: boolean;
  };
}

"""

def in_a_repository(path):
    """Whether git answers for this tree at all.

    A tree delivered without a repository, a written export or a downloaded
    archive, has no commits, so a rule about what a commit carries has nothing
    to say about it. Cases that rest on the rule say so rather than reading a
    fact about the delivery as a fault.
    """
    result = subprocess.run(["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"],
                            capture_output=True, text=True, check=False)
    return result.returncode == 0 and result.stdout.strip() == "true"


PRIMITIVES = """\
export type Color = "error" | "text" | "subtle";

export type BoxProps = {
  flexDirection?: "row" | "column";
  gap?: number;
};

export type TextProps = {
  color?: string;
  wrap?: "wrap";
};

export type ButtonProps = {
  key: string;
  label: string;
  onPress?: () => void;
  hotkey?: string;
};
"""


class DriftCase(unittest.TestCase):
    """The refusals, driven by a declaration this case writes where it likes."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-drift-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.declaration = self.root / "engine.d.ts"
        self.primitives = self.root / "host.ts"

    def run_check(self, declaration=True):
        arguments = [sys.executable, str(SCRIPT), "--primitives", str(self.primitives)]
        if declaration:
            arguments += ["--declaration", str(self.declaration)]
        result = subprocess.run(arguments, capture_output=True, text=True, check=False)
        return result.returncode, result.stdout + result.stderr

    def test_every_declared_prop_that_the_engine_carries_passes(self):
        self.declaration.write_text(ENGINE, encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 0, output)
        # Box's two and Text's two, on top of the four the button carries.
        self.assertEqual(output.strip().endswith("8 props and 3 colors checked."), True)

    def test_a_prop_the_engine_no_longer_declares_is_refused_by_name(self):
        self.declaration.write_text(ENGINE.replace("      gap?: number;\n", ""), encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("BoxProps.gap", output)

    def test_a_button_prop_the_engine_no_longer_declares_is_refused_by_name(self):
        # The button is the newest element this layout writes, so it is the one
        # most likely to drift: the engine could drop `onPress` or `hotkey` and
        # a layout that still named one would draw a control nobody can press.
        self.declaration.write_text(ENGINE.replace("      hotkey?: string;\n", ""),
                                    encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("ButtonProps.hotkey", output)

    def test_a_hover_prop_the_engine_no_longer_declares_is_refused_by_name(self):
        # A hover the surface does not know is a tree it refuses whole, so a pane
        # that lights its rows would draw nothing at all. The subset this
        # repository ships declares the hover types, so it is the one read here.
        self.declaration.write_text(ENGINE.replace("      underline?: boolean;\n", ""),
                                    encoding="utf-8")
        self.primitives.write_text(DECLARED_SUBSET.read_text(encoding="utf-8"), encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("TextHoverProps.underline", output)

    def test_an_svg_prop_the_engine_no_longer_declares_is_refused_by_name(self):
        # The desktop draws a bar, a strip and a tile as an Svg, and the engine
        # refuses an Svg without its alt: a subset that still wrote one would be
        # a pane the desktop refuses whole.
        self.declaration.write_text(ENGINE.replace("      alt: string;\n", ""), encoding="utf-8")
        self.primitives.write_text(DECLARED_SUBSET.read_text(encoding="utf-8"), encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("SvgProps.alt", output)

    def test_a_subset_without_hover_types_is_not_refused_for_them(self):
        # The hover types are checked when the subset declares them, and only
        # then: a layout that writes no hover owes the engine none.
        self.declaration.write_text(ENGINE, encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 0, output)

    def test_a_type_the_engine_no_longer_declares_is_refused(self):
        self.declaration.write_text(ENGINE.split("  export type TextProps")[0] + "}\n",
                                    encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("TextProps (the engine declares no such type)", output)

    def test_a_nested_object_type_does_not_end_the_block_early(self):
        nested = ENGINE.replace('      gap?: number;',
                                '      gap?: number;\n      border?: { top?: number; bottom?: number };')
        self.declaration.write_text(nested, encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 0, output)

    def test_the_repositorys_own_file_that_declares_nothing_is_refused(self):
        self.declaration.write_text(ENGINE, encoding="utf-8")
        self.primitives.write_text("export type Something = { a?: string };\n", encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("declares no", output)

    def test_a_declaration_that_is_not_there_reports_unavailable(self):
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 2, output)
        self.assertIn("Unavailable", output)

    def test_a_declaration_path_that_does_not_exist_reports_unavailable(self):
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        self.declaration = self.root / "absent.d.ts"
        code, output = self.run_check()
        self.assertEqual(code, 2, output)
        self.assertIn("Unavailable", output)

    def test_a_declaration_this_repository_committed_is_refused(self):
        # A declaration this repository committed is one the branch that declares
        # the subset can change with it. This names a real tracked file through
        # the real script, so the refusal is driven by the checkout itself.
        #
        # Where the tree carries no repository there is nothing this case can
        # say: nothing in it was committed, so the refusal it is about cannot
        # happen, and the file is read as a declaration like any other. The
        # exported tree is that shape.
        if not in_a_repository(ROOT):
            self.skipTest("this tree carries no repository, so nothing in it was committed")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        self.declaration = ROOT / "plugins" / "fleet" / "components" / "host.ts"
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("committed to this repository", output)

    def test_a_color_the_engine_does_not_carry_is_refused_by_name(self):
        # A color that is not a theme key follows no theme: the engine draws it
        # as whatever the terminal makes of the word, and a theme change leaves
        # it behind.
        self.declaration.write_text(ENGINE, encoding="utf-8")
        self.primitives.write_text(PRIMITIVES.replace('"subtle"', '"accent"'), encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("color accent", output)

    def test_a_declaration_with_no_theme_key_is_refused(self):
        # The whole union goes, not one key of it: the file that declares no
        # theme at all is the case, and the check must name that rather than
        # report every color in the subset as a key the engine does not carry.
        stripped = "\n".join(line for line in ENGINE.split("\n")
                             if not line.startswith("export type ThemeKey"))
        self.declaration.write_text(stripped, encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("declares no theme key", output)

    def test_a_file_declaring_no_color_is_refused(self):
        self.declaration.write_text(ENGINE, encoding="utf-8")
        self.primitives.write_text(PRIMITIVES.replace(
            'export type Color = "error" | "text" | "subtle";\n', ""), encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("declares no color", output)

    def test_a_present_declaration_is_read_even_when_it_is_large(self):
        self.declaration.write_text(ENGINE + ("\n" * 200000), encoding="utf-8")
        self.primitives.write_text(PRIMITIVES, encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 0, output)

    def test_the_declared_subset_in_this_repository_parses(self):
        # The file this repository ships is read as the check reads it, so the
        # count is a property of the file and not of the case's fixture.
        self.declaration.write_text(ENGINE, encoding="utf-8")
        self.primitives.write_text(DECLARED_SUBSET.read_text(encoding="utf-8"), encoding="utf-8")
        code, output = self.run_check()
        self.assertEqual(code, 0, output)
        self.assertIn("props and", output)
        self.assertIn("colors checked.", output)


class DefaultDeclarationCase(unittest.TestCase):
    """Which declaration the check reads when nobody names one.

    The engine scaffolds its own declaration into a plugin folder when it loads
    the plugin, so the check looks there first. That file is written into the
    tree after the checkout, so no commit carries it, which is what keeps it out
    of reach of the branch that declares the subset.

    Each case runs a copy of the script against a throwaway tree of its own, so
    the resolution is exercised by the code that resolves it rather than by
    whatever this machine happens to hold.
    """

    def setUp(self):
        self.root = self.tree()

    def tree(self, with_repository=True):
        """A throwaway checkout holding a copy of the check and nothing else."""
        root = Path(tempfile.mkdtemp(prefix="fleet-drift-root-"))
        self.addCleanup(shutil.rmtree, root, True)
        (root / "scripts").mkdir()
        shutil.copy(SCRIPT, root / "scripts" / "host-drift.py")
        (root / ".gitignore").write_text("plugins/*/.claude-plugin/types/\n", encoding="utf-8")
        if with_repository:
            subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
        return root

    def place(self, text=ENGINE, root=None, commit=False):
        """Write the engine's declaration where the host scaffolds it."""
        root = self.root if root is None else root
        target = root / SCAFFOLDED
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        if commit:
            # The path is ignored, so a declaration that reaches a commit there
            # has been forced in. That is the shape worth refusing.
            subprocess.run(["git", "-C", str(root), "add", "--force", str(SCAFFOLDED)],
                           check=True, capture_output=True)

    def run_check(self, *arguments, root=None):
        root = self.root if root is None else root
        command = [sys.executable, str(root / "scripts" / "host-drift.py"),
                   "--primitives", str(DECLARED_SUBSET)]
        result = subprocess.run(command + list(arguments), capture_output=True, text=True,
                                check=False)
        return result.returncode, result.stdout + result.stderr

    def test_the_declaration_the_engine_scaffolded_is_read_when_none_is_named(self):
        self.place()
        code, output = self.run_check()
        self.assertEqual(code, 0, output)
        self.assertIn(str(SCAFFOLDED), output)
        self.assertIn("props and", output)

    def test_a_scaffolded_declaration_a_commit_carries_is_refused(self):
        self.place(commit=True)
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("committed to this repository", output)

    def test_a_link_committed_at_the_engines_path_is_refused(self):
        # Git lists the link, not what it points at. Asking about the resolved
        # path would answer about a file outside the repository, and a committed
        # link would be read as though the engine had written it.
        outside = Path(tempfile.mkdtemp(prefix="fleet-drift-target-"))
        self.addCleanup(shutil.rmtree, outside, True)
        target = outside / "engine.d.ts"
        target.write_text(ENGINE, encoding="utf-8")
        link = self.root / SCAFFOLDED
        link.parent.mkdir(parents=True, exist_ok=True)
        try:
            link.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("this platform does not allow creating a symbolic link here")
        subprocess.run(["git", "-C", str(self.root), "add", "--force", str(SCAFFOLDED)],
                       check=True, capture_output=True)
        code, output = self.run_check()
        self.assertEqual(code, 1, output)
        self.assertIn("committed to this repository", output)

    def test_a_tree_with_no_repository_reads_a_declaration_inside_it(self):
        # What an exported tree and a downloaded archive look like: the files, and
        # no repository. Nothing there was committed by a branch, so there is
        # nothing for the check to protect, and a declaration inside the checkout
        # is read rather than refused for living in one. A host that loads the
        # plugin in such a tree scaffolds its own declaration, and refusing that
        # would fail the tree's own suite over the engine's file.
        root = self.tree(with_repository=False)
        self.place(root=root)
        code, output = self.run_check(root=root)
        self.assertEqual(code, 0, output)
        self.assertIn(str(SCAFFOLDED), output)

    def test_an_absent_declaration_is_unavailable_rather_than_a_pass(self):
        code, output = self.run_check()
        self.assertEqual(code, 2, output)
        self.assertIn("Unavailable", output)
        self.assertIn("was not checked against an engine", output)

    def test_an_absent_declaration_can_be_reported_without_failing(self):
        # What CI asks for. The runner has no engine, so the run cannot check the
        # subset; it says so in the log instead of ending the build on a check
        # that could not run here.
        code, output = self.run_check("--allow-unavailable")
        self.assertEqual(code, 0, output)
        self.assertIn("Unavailable", output)

    def test_a_named_declaration_outside_the_checkout_is_read(self):
        outside = Path(tempfile.mkdtemp(prefix="fleet-drift-elsewhere-"))
        self.addCleanup(shutil.rmtree, outside, True)
        named = outside / "engine.d.ts"
        named.write_text(ENGINE, encoding="utf-8")
        code, output = self.run_check("--declaration", str(named))
        self.assertEqual(code, 0, output)
        self.assertIn(str(named), output)


class EngineOnThisMachineCase(unittest.TestCase):
    """The claim itself, measured where an engine has written a declaration.

    The subset's size is stated in `host.ts` and in the documents beside it. This
    case is what turns that statement into something the repository checks: it
    reads the declaration the engine itself scaffolds into the plugin folder, so
    the number is counted against the engine and not against a stand-in.

    The runner has no engine, so this case skips there with the reason, and the
    run reports the skip. That is the honest shape: CI cannot check the subset
    against an engine, and a silent pass would read as though it had.
    """

    def test_the_declared_subset_is_present_in_the_engines_own_declaration(self):
        declaration = ROOT / SCAFFOLDED
        if not declaration.is_file():
            self.skipTest("no engine has scaffolded a declaration into this checkout, so the "
                          "subset was not checked against one")
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True,
                                check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(str(SCAFFOLDED), result.stdout)
        # Pinned deliberately. A subset that grows past what the engine carries
        # fails here, and a subset that grows legitimately changes this number in
        # the same commit, in the open, rather than widening a fixture.
        self.assertIn("64 props and 15 colors checked.", result.stdout)


if __name__ == "__main__":
    unittest.main()
