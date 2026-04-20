// Partition the graph into connected flat-height components and a list of
// stair segments (endpoints at different y). Flat traversal filters by the
// component's frozen y, so a node that sits between two different-y flat
// regions groups each side into its own component.

const EPS = 1e-4;

function isFlatSeg(seg, graph) {
    const a = graph.nodes.get(seg.a);
    const b = graph.nodes.get(seg.b);
    return Math.abs(a.y - b.y) < EPS;
}

export function computeFlatComponents(graph) {
    const visited = new Set();
    const components = [];
    const stairs = [];

    for (const seg of graph.segments.values()) {
        if (!isFlatSeg(seg, graph)) {
            stairs.push(seg);
            continue;
        }
        if (visited.has(seg.id)) continue;

        const comp = {
            y: graph.nodes.get(seg.a).y,
            segments: [],
            nodes: new Set(),
        };
        const queue = [seg];
        while (queue.length) {
            const s = queue.pop();
            if (visited.has(s.id)) continue;
            visited.add(s.id);
            comp.segments.push(s);
            comp.nodes.add(s.a);
            comp.nodes.add(s.b);
            for (const nodeId of [s.a, s.b]) {
                for (const nbr of graph.neighbors(nodeId)) {
                    if (visited.has(nbr.id)) continue;
                    if (!isFlatSeg(nbr, graph)) continue;
                    const na = graph.nodes.get(nbr.a);
                    const nb = graph.nodes.get(nbr.b);
                    if (Math.abs(na.y - comp.y) < EPS && Math.abs(nb.y - comp.y) < EPS) {
                        queue.push(nbr);
                    }
                }
            }
        }
        components.push(comp);
    }

    return { components, stairs };
}
