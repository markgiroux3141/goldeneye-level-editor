import os, math, numpy as np
from scipy.spatial import cKDTree

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

def pattern_analysis(fpath, name):
    print("\n" + "="*80)
    print("PATTERN ANALYSIS: " + name)
    print("="*80)
    
    vertices, colors, faces = parse_obj_file(fpath)
    
    if not colors: return
    
    # Check what % of brightness range is explained by height
    print("\n[BRIGHTNESS vs HEIGHT CORRELATION]")
    height_corr = []
    
    for f in faces:
        if not all(fi in colors for fi in f): continue
        verts = [vertices[fi] for fi in f]
        bs = [brightness(colors[fi]) for fi in f]
        ys = [v[1] for v in verts]
        
        if max(ys) - min(ys) < 5: continue  # Skip nearly flat faces
        
        y_mean = np.mean(ys)
        b_mean = np.mean(bs)
        y_var = sum((ys[i] - y_mean)**2 for i in range(3))
        b_var = sum((bs[i] - b_mean)**2 for i in range(3))
        
        if y_var > 0 and b_var > 0:
            corr = sum((ys[i] - y_mean) * (bs[i] - b_mean) for i in range(3)) / math.sqrt(y_var * b_var)
            height_corr.append(abs(corr))
    
    if height_corr:
        height_corr = np.array(height_corr)
        print("  Mean |correlation|: {:.4f}".format(np.mean(height_corr)))
        print("  % with |corr| > 0.5: {:.2f}%".format(100*np.sum(height_corr > 0.5)/len(height_corr)))
        print("  % with |corr| > 0.7: {:.2f}%".format(100*np.sum(height_corr > 0.7)/len(height_corr)))
        print("  Interpretation: Strong height correlation suggests lighting/AO is height-driven")
    
    # Analyze whether darker/lighter is consistent (e.g., always top darker)
    print("\n[DIRECTIONAL PATTERN: TOP vs BOTTOM]")
    top_darker_count = 0
    for f in faces:
        if not all(fi in colors for fi in f): continue
        verts = [vertices[fi] for fi in f]
        bs = [brightness(colors[fi]) for fi in f]
        ys = [v[1] for v in verts]
        
        if max(ys) - min(ys) < 50: continue
        
        max_y_idx = np.argmax(ys)
        min_y_idx = np.argmin(ys)
        if bs[max_y_idx] < bs[min_y_idx]: top_darker_count += 1
    
    total_wall = sum(1 for f in faces if all(fi in colors for fi in f) and 
                     max([vertices[fi][1] for fi in f]) - min([vertices[fi][1] for fi in f]) >= 50)
    
    if total_wall:
        pct = 100 * top_darker_count / total_wall
        print("  % of vertical faces where TOP is darker: {:.2f}%".format(pct))
        if pct < 45 or pct > 55:
            print("  Pattern: DIRECTIONAL (consistent lighting direction)")
        else:
            print("  Pattern: MIXED (not strongly directional)")
    
    # AO analysis - check if corners/edges are darker
    print("\n[SPATIAL GRADIENT PATTERN (AO-like or light-distance?)]")
    sig_grads = []
    for f in faces:
        if not all(fi in colors for fi in f): continue
        bs = [brightness(colors[fi]) for fi in f]
        if max(bs) - min(bs) <= 0.1: continue
        sig_grads.append({
            'verts': [vertices[fi] for fi in f],
            'bright': bs,
            'indices': f
        })
    
    # Check if darker vertex is in middle or at edges
    # For each gradient, find which vertex is darkest
    darkest_patterns = {'corner': 0, 'edge': 0, 'distributed': 0}
    
    print("  Analyzing {} significant gradient faces...".format(len(sig_grads)))
    
    if sig_grads:
        print("  Brightness range distribution within gradient faces:")
        bright_ranges = [max(g['bright']) - min(g['bright']) for g in sig_grads]
        print("    Min range: {:.4f}".format(np.min(bright_ranges)))
        print("    Max range: {:.4f}".format(np.max(bright_ranges)))
        print("    Mean range: {:.4f}".format(np.mean(bright_ranges)))

bp = "d:/Claude Code Projects/GoldenEye Level Editor/public/existing goldeneye levels"
for level in ["02 - Facility", "01 - Dam"]:
    fp = os.path.join(bp, level, "LevelIndices.obj")
    if os.path.exists(fp): pattern_analysis(fp, level)
