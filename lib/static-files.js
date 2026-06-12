import { normalize, relative, resolve } from "node:path";

function resolveStaticTarget(publicDir, requestPath) {
  let requested;
  try {
    requested = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  } catch {
    return "";
  }
  const target = normalize(resolve(publicDir, requested));
  const relation = relative(normalize(publicDir), target);
  if (relation === "" || (!relation.startsWith("..") && !relation.includes(":"))) return target;
  return "";
}

export { resolveStaticTarget };
