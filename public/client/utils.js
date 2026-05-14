export function protocolToBabylonRotation(rotDegrees) {
  return -(rotDegrees * Math.PI) / 180;
}

export function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

export function descendantsOf(transform) {
  const descendants = [];
  const stack = [...transform.getChildren()];

  while (stack.length > 0) {
    const child = stack.pop();
    descendants.push(child);

    if (typeof child.getChildren === "function") {
      stack.push(...child.getChildren());
    }
  }

  return descendants;
}

export function isMissileName(name) {
  return name.startsWith("missiles/");
}

export function colliderNodesFor(root) {
  const descendants = descendantsOf(root);
  const nodes = descendants.filter((child) => {
    const role = childRole(child.name);
    return role === "Col" || role === "ColVis";
  });
  const selfRole = childRole(root.name);
  if (selfRole === "Col" || selfRole === "ColVis") {
    nodes.push(root);
  }
  return nodes.length > 0 ? nodes : [root];
}

export function isDraggableRoot(root) {
  const name = root.name.toLowerCase();
  return name.includes("block")
    || name.includes("trebuche")
    || name.includes("missile");
}

export function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
}

export function isTrebuchetArmRoot(transform) {
  const lowerName = transform.name.toLowerCase();
  return isTrebuchetArmName(transform.name)
    && transform.parent
    && transform.parent.name.toLowerCase().includes("trebuche")
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
}

export function isTrebuchetName(name) {
  return name.startsWith("trebuchets/");
}

export function findTrebuchetArmAncestor(node) {
  let current = node;

  while (current) {
    if (isTrebuchetArmRoot(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

export function isForwardPullPoint(trebuchetState, point, releasePoint) {
  if (trebuchetState.player === 1) {
    return point.x < releasePoint.x;
  }
  return point.x > releasePoint.x;
}

export function clampAimTailPoint(headPoint, tailPoint, config) {
  const backVector = tailPoint.subtract(headPoint);
  const arrowLength = backVector.length();
  const maxArrowLength = config.aimArrowMaxLength ?? config.aimMaxPullDistance ?? 6;

  if (arrowLength <= maxArrowLength || arrowLength <= 0.0001) {
    return tailPoint;
  }

  return headPoint.add(backVector.scale(maxArrowLength / arrowLength));
}

export function clampMagnitude(vector, maxMagnitude) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude <= maxMagnitude || magnitude === 0) return vector;

  const scale = maxMagnitude / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}
