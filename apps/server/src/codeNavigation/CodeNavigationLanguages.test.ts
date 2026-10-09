import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CodeNavigation from "./CodeNavigation.ts";

const TestLayer = CodeNavigation.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** A spot in a file: the first occurrence of `needle` in `file`. */
type Spot = readonly [file: string, needle: string];

interface LanguageCase {
  readonly language: string;
  readonly files: Readonly<Record<string, string>>;
  /** Where go-to-definition lands, as `path:line:kind`. */
  readonly definitions: ReadonlyArray<readonly [...Spot, ReadonlyArray<string>]>;
  /** Every reference of a symbol, as `path:line`. */
  readonly references: readonly [...Spot, ReadonlyArray<string>];
  /** Keywords, strings and comments that resolve to nothing. */
  readonly nothing: ReadonlyArray<Spot>;
}

const CASES: ReadonlyArray<LanguageCase> = [
  {
    language: "Go",
    files: {
      "go.mod": "module example.com/m\n",
      "geo/point.go": `package geo

type Point struct {
	X int
}

func (p Point) Move(dx int) Point {
	return Point{X: p.X + dx}
}
`,
      "main.go": `package main

import "example.com/m/geo"

func double(n int) int {
	return n * 2
}

func main() {
	p := geo.Point{X: 1}
	q := p.Move(double(2))
	// double in a comment
	println("double", q.X)
}
`,
    },
    definitions: [
      ["main.go", "double(2)", ["main.go:5:function"]],
      ["main.go", "Point{X: 1}", ["geo/point.go:3:struct"]],
      ["main.go", "Move(", ["geo/point.go:7:method"]],
      ["main.go", "p.Move", ["main.go:10:variable"]],
    ],
    references: ["main.go", "double(n", ["main.go:5", "main.go:11"]],
    nothing: [
      ["main.go", "func"],
      ["main.go", "double in"],
      ["main.go", 'double",'],
    ],
  },
  {
    language: "Rust",
    files: {
      "src/shapes.rs": `pub struct Circle {
    pub radius: f64,
}

impl Circle {
    pub fn area(&self) -> f64 {
        self.radius * self.radius
    }
}
`,
      "src/main.rs": `mod shapes;
use crate::shapes::Circle;

fn scale(x: f64) -> f64 {
    x * 2.0
}

fn main() {
    let c = Circle { radius: scale(1.0) };
    // scale in a comment
    let a = c.area();
    println!("scale {}", a);
}
`,
    },
    definitions: [
      ["src/main.rs", "scale(1.0)", ["src/main.rs:4:function"]],
      ["src/main.rs", "Circle {", ["src/shapes.rs:1:struct"]],
      ["src/main.rs", "area()", ["src/shapes.rs:6:method"]],
      ["src/shapes.rs", "radius * ", ["src/shapes.rs:2:field"]],
      ["src/main.rs", "x * 2", ["src/main.rs:4:parameter"]],
    ],
    references: ["src/main.rs", "scale(x", ["src/main.rs:4", "src/main.rs:9"]],
    nothing: [
      ["src/main.rs", "fn"],
      ["src/main.rs", "scale in"],
      ["src/main.rs", "scale {}"],
    ],
  },
  {
    language: "Java",
    files: {
      "src/com/ex/Shape.java": `package com.ex;

public class Shape {
    private int size;

    public int area() {
        return size * size;
    }
}
`,
      "src/com/ex/App.java": `package com.ex;

import com.ex.Shape;

public class App {
    static int twice(int n) {
        return n * 2;
    }

    public static void main(String[] args) {
        Shape shape = new Shape();
        // twice in a comment
        String s = "twice";
        int a = twice(shape.area());
    }
}
`,
    },
    definitions: [
      ["src/com/ex/App.java", "twice(shape", ["src/com/ex/App.java:6:method"]],
      ["src/com/ex/App.java", "Shape()", ["src/com/ex/Shape.java:3:class"]],
      ["src/com/ex/App.java", "area()", ["src/com/ex/Shape.java:6:method"]],
      ["src/com/ex/Shape.java", "size * ", ["src/com/ex/Shape.java:4:field"]],
    ],
    references: [
      "src/com/ex/App.java",
      "twice(int",
      ["src/com/ex/App.java:6", "src/com/ex/App.java:14"],
    ],
    nothing: [
      ["src/com/ex/App.java", "public"],
      ["src/com/ex/App.java", "twice in"],
      ["src/com/ex/App.java", 'twice"'],
    ],
  },
  {
    language: "C#",
    files: {
      "Shape.cs": `namespace Ex;

public class Shape
{
    public int Size { get; set; }

    public int Area() => Size * Size;
}
`,
      "Program.cs": `namespace Ex;

static class Program
{
    static int Twice(int n) => n * 2;

    static void Main()
    {
        var shape = new Shape();
        // Twice in a comment
        var s = "Twice";
        var a = Twice(shape.Area());
    }
}
`,
    },
    definitions: [
      ["Program.cs", "Twice(shape", ["Program.cs:5:method"]],
      ["Program.cs", "Shape()", ["Shape.cs:3:class"]],
      ["Program.cs", "Area()", ["Shape.cs:7:method"]],
      ["Shape.cs", "Size * ", ["Shape.cs:5:field"]],
      ["Program.cs", "shape.Area", ["Program.cs:9:variable"]],
    ],
    references: ["Program.cs", "Twice(int", ["Program.cs:5", "Program.cs:12"]],
    nothing: [
      ["Program.cs", "static"],
      ["Program.cs", "Twice in"],
      ["Program.cs", 'Twice"'],
    ],
  },
  {
    language: "C",
    files: {
      "util.h": "int add(int a, int b);\n",
      "util.c": '#include "util.h"\n\nint add(int a, int b) {\n    return a + b;\n}\n',
      "main.c": `#include "util.h"

struct point {
    int x;
};

static int twice(int n) {
    return n * 2;
}

int main(void) {
    struct point p = { 1 };
    // twice in a comment
    const char *s = "twice";
    return add(twice(p.x), 0);
}
`,
    },
    definitions: [
      ["main.c", "twice(p", ["main.c:7:function"]],
      ["main.c", "add(", ["util.h:1:function", "util.c:3:function"]],
      ["main.c", "x)", ["main.c:4:field"]],
      ["main.c", "point p", ["main.c:3:struct"]],
    ],
    references: ["main.c", "twice(int", ["main.c:7", "main.c:15"]],
    nothing: [
      ["main.c", "return"],
      ["main.c", "twice in"],
      ["main.c", 'twice"'],
    ],
  },
  {
    language: "C++",
    files: {
      "shape.hpp": `namespace geo {
class Shape {
public:
    int area() const;
    int size;
};
}
`,
      "shape.cpp": `#include "shape.hpp"

int geo::Shape::area() const {
    return size * size;
}
`,
      "main.cpp": `#include "shape.hpp"

int use(geo::Shape *shape) {
    // area in a comment
    return shape->area();
}
`,
    },
    definitions: [
      ["main.cpp", "area()", ["shape.hpp:4:method", "shape.cpp:3:method"]],
      ["main.cpp", "Shape *", ["shape.hpp:2:class"]],
      ["shape.cpp", "size * ", ["shape.hpp:5:field"]],
      ["main.cpp", "shape->", ["main.cpp:3:parameter"]],
    ],
    references: ["shape.hpp", "size;", ["shape.hpp:5", "shape.cpp:4", "shape.cpp:4"]],
    nothing: [
      ["main.cpp", "return"],
      ["main.cpp", "area in"],
    ],
  },
  {
    language: "PHP",
    files: {
      "src/App/Shape.php": `<?php
namespace App;

class Shape
{
    private int $size = 2;

    public function area(): int
    {
        return $this->size * $this->size;
    }
}
`,
      "src/main.php": `<?php
use App\\Shape;

function twice(int $n): int
{
    return $n * 2;
}

$shape = new Shape();
// twice in a comment
$s = "twice";
echo twice($shape->area());
`,
    },
    definitions: [
      ["src/main.php", "twice($shape", ["src/main.php:4:function"]],
      ["src/main.php", "Shape()", ["src/App/Shape.php:4:class"]],
      ["src/main.php", "area()", ["src/App/Shape.php:8:method"]],
      ["src/App/Shape.php", "size * ", ["src/App/Shape.php:6:field"]],
      ["src/main.php", "$shape->", ["src/main.php:9:variable"]],
    ],
    references: ["src/main.php", "twice(int", ["src/main.php:4", "src/main.php:12"]],
    nothing: [
      ["src/main.php", "function"],
      ["src/main.php", "twice in"],
      ["src/main.php", 'twice"'],
    ],
  },
  {
    language: "Ruby",
    files: {
      "lib/shape.rb": `class Shape
  def initialize(size)
    @size = size
  end

  def area
    @size * @size
  end
end
`,
      "main.rb": `require_relative "lib/shape"

def twice(n)
  n * 2
end

shape = Shape.new(2)
# twice in a comment
s = "twice"
puts twice(shape.area)
`,
    },
    definitions: [
      ["main.rb", "twice(shape", ["main.rb:3:method"]],
      ["main.rb", "Shape.new", ["lib/shape.rb:1:class"]],
      ["main.rb", "area)", ["lib/shape.rb:6:method"]],
      ["lib/shape.rb", "@size *", ["lib/shape.rb:3:field"]],
      ["main.rb", "shape.area", ["main.rb:7:variable"]],
    ],
    references: ["main.rb", "twice(n", ["main.rb:3", "main.rb:10"]],
    nothing: [
      ["main.rb", "def"],
      ["main.rb", "twice in"],
      ["main.rb", 'twice"'],
    ],
  },
  {
    language: "Bash",
    files: {
      "lib.sh": 'greet() {\n  local name="$1"\n  echo "hello $name"\n}\n',
      "main.sh": `#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"

COUNT=3
twice() {
  echo $(( $1 * 2 ))
}

# twice in a comment
greet "twice"
twice "$COUNT"
`,
    },
    definitions: [
      ["main.sh", 'twice "', ["main.sh:5:function"]],
      ["main.sh", 'COUNT"', ["main.sh:4:variable"]],
      ["main.sh", "greet", ["lib.sh:1:function"]],
      ["lib.sh", 'name"', ["lib.sh:2:local"]],
    ],
    references: ["main.sh", "twice()", ["main.sh:5", "main.sh:11"]],
    nothing: [
      ["lib.sh", "local"],
      ["main.sh", "twice in"],
      ["main.sh", 'twice"'],
    ],
  },
  {
    language: "PowerShell",
    files: {
      "lib.ps1": `function Get-Twice {
    param($Value)
    return $Value * 2
}

class Shape {
    [int]$Size = 2

    [int] Area() {
        return $this.Size * $this.Size
    }
}
`,
      "main.ps1": `. $PSScriptRoot/lib.ps1

$shape = [Shape]::new()
# Get-Twice in a comment
$s = "Get-Twice"
Get-Twice -Value $shape.Area()
`,
    },
    definitions: [
      ["main.ps1", "Get-Twice -Value", ["lib.ps1:1:function"]],
      ["main.ps1", "Shape]", ["lib.ps1:6:class"]],
      ["main.ps1", "Area()", ["lib.ps1:9:method"]],
      ["lib.ps1", "Size * ", ["lib.ps1:7:field"]],
      ["lib.ps1", "$Value *", ["lib.ps1:2:parameter"]],
      ["main.ps1", "$shape.Area", ["main.ps1:3:variable"]],
    ],
    references: ["lib.ps1", "Get-Twice {", ["lib.ps1:1", "main.ps1:6"]],
    nothing: [
      ["lib.ps1", "function"],
      ["main.ps1", "Get-Twice in"],
      ["main.ps1", 'Get-Twice"'],
    ],
  },
  {
    language: "CSS",
    files: {
      "styles/theme.css": ":root {\n  --brand: #f00;\n}\n",
      "styles/app.css": `@import "./theme.css";

.card {
  color: var(--brand);
}

/* card in a comment */
.card:hover {
  content: "card";
}
`,
    },
    definitions: [
      ["styles/app.css", "--brand)", ["styles/theme.css:2:variable"]],
      // Every rule naming a class defines it; on one, it is its own definition.
      ["styles/app.css", "card {", ["styles/app.css:3:class"]],
    ],
    references: ["styles/theme.css", "--brand", ["styles/theme.css:2", "styles/app.css:4"]],
    nothing: [
      ["styles/app.css", "color"],
      ["styles/app.css", "card in"],
      ["styles/app.css", 'card"'],
    ],
  },
  {
    language: "JavaScript modules",
    files: {
      "lib/math.cjs": "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n",
      "lib/index.mjs": 'export { add } from "./math.cjs";\n',
      "main.mjs": 'import { add } from "./lib/index.mjs";\n\nadd(1, 2);\n',
    },
    definitions: [["main.mjs", "add(", ["lib/math.cjs:1:function"]]],
    references: [
      "main.mjs",
      "add(",
      ["lib/math.cjs:1", "lib/math.cjs:4", "lib/index.mjs:1", "main.mjs:1", "main.mjs:3"],
    ],
    nothing: [["main.mjs", "import"]],
  },
];

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({ operation: "test.git", command: "git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

/** A repository with one commit holding `files`; returns it and the commit. */
const makeRepository = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "code-navigation-languages-" });
    for (const [file, contents] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, file), contents);
    }
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test"]);
    yield* runGit(cwd, ["add", "."]);
    yield* runGit(cwd, ["commit", "-m", "files"]);
    return { cwd, ref: yield* runGit(cwd, ["rev-parse", "HEAD"]) };
  });

/** The request for a spot: 1-based line and 0-based column of the needle's first character. */
function request(
  repository: { readonly cwd: string; readonly ref: string },
  files: Readonly<Record<string, string>>,
  [path, needle]: Spot,
) {
  const text = files[path]!;
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`${needle} not found in ${path}`);
  const before = text.slice(0, index).split("\n");
  return {
    cwd: repository.cwd,
    revision: { _tag: "git" as const, ref: repository.ref },
    path,
    line: before.length,
    column: before.at(-1)!.length,
  };
}

describe("CodeNavigation languages", () => {
  it.effect.each(CASES)("navigates $language", ({ files, definitions, references, nothing }) =>
    Effect.gen(function* () {
      const repository = yield* makeRepository(files);
      const navigation = yield* CodeNavigation.CodeNavigation;
      for (const [path, needle, expected] of definitions) {
        const result = yield* navigation.resolveDefinition(
          request(repository, files, [path, needle]),
        );
        assert.deepStrictEqual(
          result.definitions.map(({ path, line, kind }) => `${path}:${line}:${kind}`),
          expected,
          `definition of ${needle} in ${path}`,
        );
      }
      const [path, needle, expected] = references;
      const found = yield* navigation.findReferences(request(repository, files, [path, needle]));
      assert.deepStrictEqual(
        found.references.map(({ path, line }) => `${path}:${line}`).toSorted(),
        [...expected].toSorted(),
        `references of ${needle} in ${path}`,
      );
      for (const spot of nothing) {
        const result = yield* navigation.resolveDefinition(request(repository, files, spot));
        assert.deepStrictEqual(result.definitions, [], `nothing at ${spot[1]} in ${spot[0]}`);
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
