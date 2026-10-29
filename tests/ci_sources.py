"""Where CI step logic lives now: thin steps in ci.yml, bodies in the justfile.

The workflow contract tests used to read a step's inline `run:` script. The
substantial ones moved into justfile recipes, so the tests read the recipe body
from here instead; what they assert about the script is unchanged.
"""
from pathlib import Path

ROOT = Path(__file__).parents[1]
JUSTFILE = ROOT / 'justfile'


def recipe(name):
    """Body of recipe `name` (the indented lines under its header), de-indented."""
    lines = JUSTFILE.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.split(':', 1)[0].split(' ')[0] == name and line.startswith(name))
    body = []
    for line in lines[start + 1:]:
        if line and not line.startswith((' ', '\t')):
            break
        body.append(line[4:] if line.startswith('    ') else line)
    return '\n'.join(body).rstrip() + '\n'


def workflow_text():
    """ci.yml plus the justfile whose recipes its steps run."""
    return (ROOT / '.github/workflows/ci.yml').read_text() + '\n' + JUSTFILE.read_text()
