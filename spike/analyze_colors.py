import os, re, math, numpy as np

def parse_obj_file(filepath):
    vertices, colors, faces = {}, {}, []
    current_color = None
    vertex_idx = 0
    
    for line in open(filepath):
        line = line.rstrip()
        if not line or (line.startswith("#") and not line.startswith("#vcolor")): continue
                
        if line.startswith("v "):
            parts = line.split()
            vertex_idx += 1
            x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
            vertices[vertex_idx] = (x, y, z)
            if current_color: colors[vertex_idx] = current_color
        
        elif line.startswith("#vcolor "):
            parts = line.split()
            r, g, b = float(parts[1])/255, float(parts[2])/255, float(parts[3])/255
            a = float(parts[4])/255 if len(parts) > 4 else 1
            current_color = (r, g, b, a)
        
        elif line.startswith("f "):
            parts = line.split()[1:]
            face_verts = [int(p.split("/")[0]) for p in parts]
            if len(face_verts) >= 3:
                for i in range(1, len(face_verts) - 1):
                    faces.append([face_verts[0], face_verts[i], face_verts[i+1]])
    
    return vertices, colors, faces

def brightness(c): return (c[0] + c[1] + c[2]) / 3.0

def face_normal(v1, v2, v3):
    v1, v2, v3 = np.array(v1), np.array(v2), np.array(v3)
    edge1, edge2 = v2 - v1, v3 - v1
    n = np.cross(edge1, edge2)
    norm = np.linalg.norm(n)
    return n / norm if norm > 0 else n

def analyze_level(fpath, name):
    print("\n" + "="*80 + "\nAnalyzing: " + name + "\n" + "="*80)
    vertices, colors, faces = parse_obj_file(fpath)
    
    if not vertices: print("No vertices"); return
    print("Vertices: {}, Faces: {}, Colors: {}".format(len(vertices), len(faces), len(colors)))
    
    if not colors: print("WARNING: No colors"); return
    
    # Analysis 1
    print("\n--- ANALYSIS 1: Per-Face Brightness Variation ---")
    ranges = [max(brightness(colors[f[0]]), brightness(colors[f[1]]), brightness(colors[f[2]])) - 
              min(brightness(colors[f[0]]), brightness(colors[f[1]]), brightness(colors[f[2]]))
              for f in faces if all(fi in colors for fi in f)]
    
    if ranges:
        ranges = np.array(ranges)
        print("Mean brightness range: {:.4f}".format(np.mean(ranges)))
        print("Median brightness range: {:.4f}".format(np.median(ranges)))
        print("% faces with range > 0.1: {:.2f}%".format(100*np.sum(ranges > 0.1)/len(ranges)))
        print("% faces with range > 0.2: {:.2f}%".format(100*np.sum(ranges > 0.2)/len(ranges)))
    
    # Analysis 2
    print("\n--- ANALYSIS 2: Height-Correlated Gradients (Vertical Walls) ---")
    darker, lighter, wall_count = 0, 0, 0
    
    for f in faces:
        if not all(fi in colors for fi in f): continue
        v1, v2, v3 = [vertices[fi] for fi in f]
        n = face_normal(v1, v2, v3)
        if abs(n[1]) >= 0.3: continue
        
        y_vals = [v1[1], v2[1], v3[1]]
        if max(y_vals) - min(y_vals) < 50: continue
        
        wall_count += 1
        max_y_idx = np.argmax(y_vals)
        high_b = brightness(colors[f[max_y_idx]])
        low_b = brightness(colors[f[np.argmin(y_vals)]])
        
        if high_b < low_b: darker += 1
        else: lighter += 1
    
    if wall_count:
        print("Wall faces: {}".format(wall_count))
        print("% higher vertex darker: {:.2f}%".format(100*darker/wall_count))
        print("% higher vertex lighter: {:.2f}%".format(100*lighter/wall_count))
    else:
        print("No wall faces found")
    
    # Analysis 3
    print("\n--- ANALYSIS 3: Gradient Direction Analysis ---")
    sig_grads = [{'coords': [vertices[fi] for fi in f], 'bright': [brightness(colors[fi]) for fi in f]}
                 for f in faces if all(fi in colors for fi in f) and
                 (max(brightness(colors[fi]) for fi in f) - min(brightness(colors[fi]) for fi in f)) > 0.1]
    
    if sig_grads:
        print("Faces with gradients > 0.1: {}".format(len(sig_grads)))
        
        y_corr = sum(1 for g in sig_grads if abs(sum((g['coords'][i][1] - np.mean([c[1] for c in g['coords']])) * 
                     (g['bright'][i] - np.mean(g['bright'])) for i in range(3))) > 0.01)
        print("% with Y correlation: {:.2f}%".format(100*y_corr/len(sig_grads) if sig_grads else 0))
        
        all_c = [c for g in sig_grads for c in g['coords']]
        cx, cz = np.mean([c[0] for c in all_c]), np.mean([c[2] for c in all_c])
        
        dist_corr = sum(1 for g in sig_grads if abs(sum((math.sqrt((g['coords'][i][0]-cx)**2 + (g['coords'][i][2]-cz)**2) - 
                        np.mean([math.sqrt((c[0]-cx)**2 + (c[2]-cz)**2) for c in g['coords']])) * 
                        (g['bright'][i] - np.mean(g['bright'])) for i in range(3))) > 0.01
                        and max([math.sqrt((c[0]-cx)**2 + (c[2]-cz)**2) for c in g['coords']]) - 
                        min([math.sqrt((c[0]-cx)**2 + (c[2]-cz)**2) for c in g['coords']]) > 10)
        print("% with distance correlation: {:.2f}%".format(100*dist_corr/len(sig_grads)))
    
    # Analysis 4
    print("\n--- ANALYSIS 4: Neighbor Influence and Spatial Smoothness ---")
    bright_map = {vi: brightness(colors[vi]) for vi in colors}
    diffs = []
    
    for vi in colors:
        if vi not in vertices: continue
        for oi in colors:
            if oi <= vi or oi not in vertices: continue
            d = math.sqrt(sum((vertices[vi][j] - vertices[oi][j])**2 for j in range(3)))
            if d <= 100: diffs.append((d, abs(bright_map[vi] - bright_map[oi])))
    
    if diffs:
        diffs = np.array(diffs)
        corr = np.corrcoef(diffs[:, 0], diffs[:, 1])[0, 1] if len(diffs) > 1 else 0
        print("Neighbor pairs (<=100 units): {}".format(len(diffs)))
        print("Mean brightness diff: {:.4f}".format(np.mean(diffs[:, 1])))
        print("Median brightness diff: {:.4f}".format(np.median(diffs[:, 1])))
        print("Correlation: {:.4f}".format(corr))
        if abs(corr) > 0.3: print("  -> Spatial gradient")
        elif abs(corr) < 0.1: print("  -> Independent colors")

bp = "d:/Claude Code Projects/GoldenEye Level Editor/public/existing goldeneye levels"
for level in ["02 - Facility", "01 - Dam"]:
    fp = os.path.join(bp, level, "LevelIndices.obj")
    if os.path.exists(fp): analyze_level(fp, level)
    else: print("Not found: " + fp)
