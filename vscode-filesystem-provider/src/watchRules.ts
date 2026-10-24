/** VS Code watch excludes are globs, relative to the watched folder. */
export function compileWatchExclude(glob: string): RegExp {
  let result = "";
  let braces = 0;
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        result += "(?:.*/)?";
        index++;
      } else result += ".*";
    } else if (char === "*") result += "[^/]*";
    else if (char === "?") result += "[^/]";
    else if (char === "{") {
      braces++;
      result += "(?:";
    } else if (char === "}") {
      braces--;
      result += ")";
    } else if (char === ",") result += braces > 0 ? "|" : ",";
    else if (char === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end > index) {
        result += glob.slice(index, end + 1).replace("[!", "[^");
        index = end;
      } else result += "\\[";
    } else result += char.replace(/[\\^$+().|]/g, "\\$&");
  }
  try {
    return new RegExp(`^${result}(?:/.*)?$`);
  } catch {
    return /$a/;
  }
}

export function watchIncludes(
  base: string,
  target: string,
  recursive: boolean,
  excludes: RegExp[],
): boolean {
  const root = base.replace(/\/+$/, "");
  if (root && target !== root && !target.startsWith(`${root}/`)) return false;
  const relative = target.slice(root.length).replace(/^\//, "");
  if (!recursive && relative.includes("/")) return false;
  return !excludes.some(
    (exclude) => exclude.test(relative) || exclude.test(target),
  );
}
