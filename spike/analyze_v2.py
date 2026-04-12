import os, math, numpy as np

def parse_obj_file(fpath):
    vertices, colors, faces = {}, {}, []
    cur_color = None
    v_idx = 0
    
    for line in open(fpath):
        line = line.rstrip()
        if not line or (line.startswith('#') and not line.startswith('#vcolor')): 
            continue
                
        if line.startswith('v '):
            parts = line.split()
            v_idx += 1
            vertices[v_idx] = (float(parts[1]), float(parts[2]), float(parts[3]))
            if cur_color: colors[v_idx] = cur_color
        
        elif line.startswith('#vcolor '):
            parts = line.split()
            cur_color = (float(parts[1])/255, float(parts[2])/255, float(parts[3])/255, 
                        float(parts[4])/255 if len(parts) > 4 else 1)
        
        elif line.startswith('f '):
            face_verts = [int(p.split('/')[0]) for p in line.split()[1:]]
            if len(face_verts) >= 3:
                for i in range(1, len(face_verts) - 1):
                    faces.append([face_verts[0], face_verts[i], face_verts[i+1]])
    
    return vertices, colors, faces

def brightness(c): return (c[0] + c[1] + c[2]) / 3.0

def face_normal(v1, v2, v3):
    v1, v2, v3 = np.array(v1), np.array(v2), np.array(v3)
    n = np.cross(v2 - v1, v3 - v1)
    norm = np.linalg.norm(n)
    return n / norm if norm > 0 else n

def analyze(fpath, name):
    print("\n" + "="*80)
    print("Analyzing: " + name)
    print("="*80)
    
    vertices, colors, faces = parse_obj_file(fpath)
    
    if not vertices: return
    print("V: {}, F: {}, C: {}".format(len(vertices), len(faces), len(colors)))
    
    if not colors: return
    
    # Analysis 1: Per-face brightness variation
    print("\n[1] PER-FACE BRIGHTNESS VARIATION")
    ranges = []
    for f in faces:
        if not all(fi in colors for fi in f): continue
        bs = [brightness(colors[fi]) for fi in f]
        ranges.append(max(bs) - min(bs))
    
    if ranges:
        ranges = np.array(ranges)
        print("  Mean range: {:.4f}".format(np.mean(ranges)))
        print("  Median range: {:.4f}".format(np.median(ranges)))
        print("  % > 0.1: {:.2f}%".format(100*np.sum(ranges > 0.1)/len(ranges)))
        print("  % > 0.2: {:.2f}%".format(100*np.sum(ranges > 0.2)/len(ranges)))
    
    # Analysis 2: Height-correlated gradients
    print("\n[2] HEIGHT-CORRELATED GRADIENTS (VERTICAL WALLS)")
    darker, lighter, wall_count = 0, 0, 0
    
    for f in faces:
        if not all(fi in colors for fi in f): continue
        verts = [vertices[fi] for fi in f]
        n = face_normal(*verts)
        if abs(n[1]) >= 0.3: continue
        
        ys = [v[1] for v in verts]
        if max(ys) - min(ys) < 50: continue
        
        wall_count += 1
        max_y_idx = np.argmax(ys)
        if brightness(colors[f[max_y_idx]]) < brightness(colors[f[np.argmin(ys)]]):
            darker += 1
        else:
            lighter += 1
    
    if wall_count:
        print("  Wall faces: {}".format(wall_count))
        print("  % higher darker: {:.2f}%".format(100*darker/wall_count))
        print("  % higher lighter: {:.2f}%".format(100*lighter/wall_count))
    
    # Analysis 3: Gradient direction analysis
    print("\n[3] GRADIENT DIRECTION ANALYSIS")
    sig_grads = []
    for f in faces:
        if not all(fi in colors for fi in f): continue
        bs = [brightness(colors[fi]) for fi in f]
        if max(bs) - min(bs) <= 0.1: continue
        sig_grads.append({'f': f, 'verts': [vertices[fi] for fi in f], 'bright': bs})
    
    if sig_grads:
        print("  Significant gradients (>0.1): {}".format(len(sig_grads)))
        
        # Y correlation
        y_corr = 0
        for g in sig_grads:
            ys = [v[1] for v in g['verts']]
            y_mean = np.mean(ys)
            b_mean = np.mean(g['bright'])
            corr = sum((ys[i] - y_mean) * (g['bright'][i] - b_mean) for i in range(3))
            if abs(corr) > 0.01: y_corr += 1
        
        print("  % with Y correlation: {:.2f}%".format(100*y_corr/len(sig_grads)))
        
        # Distance correlation
        all_verts = [v for g in sig_grads for v in g['verts']]
        cx = np.mean([v[0] for v in all_verts])
        cz = np.mean([v[2] for v in all_verts])
        
        d_corr = 0
        for g in sig_grads:
            ds = [math.sqrt((v[0]-cx)**2 + (v[2]-cz)**2) for v in g['verts']]
            if max(ds) - min(ds) < 10: continue
            d_mean = np.mean(ds)
            b_mean = np.mean(g['bright'])
            corr = sum((ds[i] - d_mean) * (g['bright'][i] - b_mean) for i in range(3))
            if abs(corr) > 0.01: d_corr += 1
        
        print("  % with distance correlation: {:.2f}%".format(100*d_corr/len(sig_grads)))
    
    # Analysis 4: Spatial smoothness (sample-based to avoid O(n^2))
    print("\n[4] NEIGHBOR INFLUENCE & SPATIAL SMOOTHNESS")
    print("  Sampling 5000 random vertex pairs within 100 units...")
    
    color_verts = [(vi, vertices[vi]) for vi in colors]
    diffs = []
    
    for _ in range(5000):
        idx1 = np.random.randint(0, len(color_verts))
        idx2 = np.random.randint(0, len(color_verts))
        if idx1 == idx2: continue
        
        vi1, v1 = color_verts[idx1]
        vi2, v2 = color_verts[idx2]
        
        d = math.sqrt(sum((v1[j] - v2[j])**2 for j in range(3)))
        if d <= 100:
            bright_diff = abs(brightness(colors[vi1]) - brightness(colors[vi2]))
            diffs.append((d, bright_diff))
    
    if diffs:
        diffs = np.array(diffs)
        corr = np.corrcoef(diffs[:, 0], diffs[:, 1])[0, 1] if len(diffs) > 1 else 0
        print("  Pairs sampled: {}".format(len(diffs)))
        print("  Mean brightness diff: {:.4f}".format(np.mean(diffs[:, 1])))
        print("  Median brightness diff: {:.4f}".format(np.median(diffs[:, 1])))
        print("  Correlation (dist vs diff): {:.4f}".format(corr))
        if abs(corr) > 0.3: print("    -> Spatial gradient (smooth)")
        elif abs(corr) < 0.1: print("    -> Independent (random)")

bp = "d:/Claude Code Projects/GoldenEye Level Editor/public/existing goldeneye levels"
for level in ["02 - Facility", "01 - Dam"]:
    fp = os.path.join(bp, level, "LevelIndices.obj")
    if os.path.exists(fp): analyze(fp, level)
