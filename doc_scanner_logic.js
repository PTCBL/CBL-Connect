/**
 * CBL CONNECT - AUTO DOCUMENT SCANNER & PERSPECTIVE DEWARP ENGINE
 * Fitur:
 * 1. Auto 4-Corner Detection & Perspective Homography Warp (Meluruskan Sudut Miring)
 * 2. Magic Color Filter (Pemutih Kertas + Penajam Teks / Stempel)
 * 3. Rotasi 90 Derajat Instan (Rotate 90°)
 * 4. Modal Crop Manual 4-Sudut Interaktif (Touch & Mouse Drag)
 */

window.CBLDocScanner = (function () {
    const MAX_DIM = 1200; // Resolusi kerja dokumen tajam & ringan

    // ====================================================================
    // 1. MATRIKS HOMOGRAFI & PERSPECTIVE WARP (BILINEAR)
    // ====================================================================

    function getHomography(srcPoints, dstPoints) {
        let A = [];
        for (let i = 0; i < 4; i++) {
            let u = srcPoints[i].x, v = srcPoints[i].y;
            let x = dstPoints[i].x, y = dstPoints[i].y;
            A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
            A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
        }
        let n = 8;
        for (let i = 0; i < n; i++) {
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
            }
            let tmp = A[i]; A[i] = A[maxRow]; A[maxRow] = tmp;
            let pivot = A[i][i];
            if (Math.abs(pivot) < 1e-9) continue;
            for (let j = i; j <= n; j++) A[i][j] /= pivot;
            for (let k = 0; k < n; k++) {
                if (k === i) continue;
                let factor = A[k][i];
                for (let j = i; j <= n; j++) A[k][j] -= factor * A[i][j];
            }
        }
        let h = [];
        for (let i = 0; i < n; i++) h.push(A[i][n]);
        h.push(1);

        return function (u, v) {
            let denom = h[6] * u + h[7] * v + 1;
            return {
                x: (h[0] * u + h[1] * v + h[2]) / denom,
                y: (h[3] * u + h[4] * v + h[5]) / denom
            };
        };
    }

    /**
     * Meluruskan quadrilateral 4-sudut menjadi persegi panjang datar (Perspective Dewarp)
     */
    function warpPerspective(srcCanvas, corners, outW, outH) {
        let dstCanvas = document.createElement('canvas');
        dstCanvas.width = outW;
        dstCanvas.height = outH;

        let srcCtx = srcCanvas.getContext('2d');
        let dstCtx = dstCanvas.getContext('2d');

        let srcImgData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        let dstImgData = dstCtx.createImageData(outW, outH);

        let src32 = new Uint32Array(srcImgData.data.buffer);
        let dst32 = new Uint32Array(dstImgData.data.buffer);

        let srcW = srcCanvas.width;
        let srcH = srcCanvas.height;

        let dstQuad = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
        let mapper = getHomography(dstQuad, corners);

        let idx = 0;
        for (let y = 0; y < outH; y++) {
            for (let x = 0; x < outW; x++) {
                let pt = mapper(x, y);
                let sx = pt.x | 0;
                let sy = pt.y | 0;
                if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
                    dst32[idx] = src32[sy * srcW + sx];
                } else {
                    dst32[idx] = 0xFFFFFFFF; // Putih di luar batas
                }
                idx++;
            }
        }

        dstCtx.putImageData(dstImgData, 0, 0);
        return dstCanvas;
    }

    // ====================================================================
    // 2. DETEKSI 4 SUDUT KERTAS OTOMATIS (CORNER & TILT DETECTION)
    // ====================================================================

    function dist(p1, p2) {
        let dx = p1.x - p2.x, dy = p1.y - p2.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Deteksi 4 sudut batas dokumen berdasarkan Ray-Casting & Line Fitting
     * Tahan terhadap miring/tilt, bayangan meja, dan dokumen landscape/portrait
     */
    function detectDocumentCorners(ctx, w, h) {
        let defaultCorners = [
            { x: 0, y: 0 },
            { x: w, y: 0 },
            { x: w, y: h },
            { x: 0, y: h }
        ];

        try {
            let imgData = ctx.getImageData(0, 0, w, h);
            let d = imgData.data;

            // 1. Hitung kecerahan rata-rata pusat (kertas) vs tepi (meja)
            let centerLumaSum = 0, centerCount = 0;
            let cx1 = Math.round(w * 0.28), cx2 = Math.round(w * 0.72);
            let cy1 = Math.round(h * 0.28), cy2 = Math.round(h * 0.72);
            for (let y = cy1; y < cy2; y += 4) {
                for (let x = cx1; x < cx2; x += 4) {
                    let idx = (y * w + x) * 4;
                    centerLumaSum += 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
                    centerCount++;
                }
            }
            let avgPaper = centerLumaSum / (centerCount || 1);

            let borderLumaSum = 0, borderCount = 0;
            let borderSamples = [
                [6, 6], [w - 7, 6], [6, h - 7], [w - 7, h - 7],
                [Math.round(w / 2), 6], [Math.round(w / 2), h - 7],
                [6, Math.round(h / 2)], [w - 7, Math.round(h / 2)]
            ];
            borderSamples.forEach(([bx, by]) => {
                let idx = (by * w + bx) * 4;
                borderLumaSum += 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
                borderCount++;
            });
            let avgBorder = borderLumaSum / (borderCount || 1);

            // Jika kontras background meja vs kertas sangat rendah (misal kertas putih di atas meja putih)
            if (Math.abs(avgPaper - avgBorder) < 20) {
                return { corners: defaultCorners, isDetected: false };
            }

            let isDarkBackground = avgBorder < avgPaper;
            let threshold = (avgPaper + avgBorder) / 2;

            function isPaperPixel(x, y) {
                let idx = (y * w + x) * 4;
                let luma = 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
                return isDarkBackground ? (luma >= threshold) : (luma <= threshold);
            }

            // Ray-casting dari 4 sisi ke arah pusat
            let topPts = [], botPts = [], leftPts = [], rightPts = [];
            let stepX = Math.max(3, Math.floor(w / 50));
            let stepY = Math.max(3, Math.floor(h / 50));

            for (let x = Math.round(w * 0.08); x < Math.round(w * 0.92); x += stepX) {
                for (let y = 3; y < Math.round(h * 0.55); y += 2) {
                    if (isPaperPixel(x, y)) {
                        topPts.push({ x, y });
                        break;
                    }
                }
            }

            for (let x = Math.round(w * 0.08); x < Math.round(w * 0.92); x += stepX) {
                for (let y = h - 4; y > Math.round(h * 0.45); y -= 2) {
                    if (isPaperPixel(x, y)) {
                        botPts.push({ x, y });
                        break;
                    }
                }
            }

            for (let y = Math.round(h * 0.08); y < Math.round(h * 0.92); y += stepY) {
                for (let x = 3; x < Math.round(w * 0.55); x += 2) {
                    if (isPaperPixel(x, y)) {
                        leftPts.push({ x, y });
                        break;
                    }
                }
            }

            for (let y = Math.round(h * 0.08); y < Math.round(h * 0.92); y += stepY) {
                for (let x = w - 4; x > Math.round(w * 0.45); x -= 2) {
                    if (isPaperPixel(x, y)) {
                        rightPts.push({ x, y });
                        break;
                    }
                }
            }

            // Fit garis regresi linier
            function fitLineYofX(pts) {
                if (pts.length < 4) return null;
                let n = pts.length;
                let meanX = pts.reduce((s, p) => s + p.x, 0) / n;
                let meanY = pts.reduce((s, p) => s + p.y, 0) / n;
                let denom = pts.reduce((s, p) => s + (p.x - meanX) ** 2, 0);
                if (denom === 0) return null;
                let m = pts.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0) / denom;
                let c = meanY - m * meanX;
                return { m, c };
            }

            function fitLineXofY(pts) {
                if (pts.length < 4) return null;
                let n = pts.length;
                let meanX = pts.reduce((s, p) => s + p.x, 0) / n;
                let meanY = pts.reduce((s, p) => s + p.y, 0) / n;
                let denom = pts.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
                if (denom === 0) return null;
                let m = pts.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0) / denom;
                let c = meanX - m * meanY;
                return { m, c };
            }

            let topLine = fitLineYofX(topPts);
            let botLine = fitLineYofX(botPts);
            let leftLine = fitLineXofY(leftPts);
            let rightLine = fitLineXofY(rightPts);

            if (topLine && botLine && leftLine && rightLine) {
                function intersect(lineY, lineX) {
                    let m1 = lineY.m, c1 = lineY.c;
                    let m2 = lineX.m, c2 = lineX.c;
                    let denom = 1 - m1 * m2;
                    if (Math.abs(denom) < 1e-5) return null;
                    let y = (m1 * c2 + c1) / denom;
                    let x = m2 * y + c2;
                    return { x, y };
                }

                let tl = intersect(topLine, leftLine);
                let tr = intersect(topLine, rightLine);
                let br = intersect(botLine, rightLine);
                let bl = intersect(botLine, leftLine);

                if (tl && tr && br && bl) {
                    tl = { x: Math.max(0, Math.min(w, Math.round(tl.x))), y: Math.max(0, Math.min(h, Math.round(tl.y))) };
                    tr = { x: Math.max(0, Math.min(w, Math.round(tr.x))), y: Math.max(0, Math.min(h, Math.round(tr.y))) };
                    br = { x: Math.max(0, Math.min(w, Math.round(br.x))), y: Math.max(0, Math.min(h, Math.round(br.y))) };
                    bl = { x: Math.max(0, Math.min(w, Math.round(bl.x))), y: Math.max(0, Math.min(h, Math.round(bl.y))) };

                    let topW = dist(tl, tr);
                    let botW = dist(bl, br);
                    let leftH = dist(tl, bl);
                    let rightH = dist(tr, br);

                    let avgW = (topW + botW) / 2;
                    let avgH = (leftH + rightH) / 2;

                    if (avgW > w * 0.30 && avgH > h * 0.30) {
                        return {
                            corners: [tl, tr, br, bl],
                            isDetected: true
                        };
                    }
                }
            }
        } catch (e) {
            console.warn("Corner detection fallback:", e);
        }

        return { corners: defaultCorners, isDetected: false };
    }

    // ====================================================================
    // 3. MAGIC SCAN CONTRAST & BACKGROUND WHITENER
    // ====================================================================

    function applyMagicScanFilter(ctx, w, h) {
        let imgData = ctx.getImageData(0, 0, w, h);
        let d = imgData.data;

        let lumaValues = [];
        let step = Math.max(1, Math.floor((w * h) / 4000));
        for (let i = 0; i < d.length; i += step * 4) {
            let luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            lumaValues.push(luma);
        }
        lumaValues.sort((a, b) => a - b);
        let whitePoint = lumaValues[Math.floor(lumaValues.length * 0.88)] || 200;
        let blackPoint = lumaValues[Math.floor(lumaValues.length * 0.08)] || 40;

        whitePoint = Math.max(160, Math.min(235, whitePoint));
        blackPoint = Math.max(15, Math.min(80, blackPoint));
        let range = Math.max(1, whitePoint - blackPoint);

        for (let i = 0; i < d.length; i += 4) {
            let r = d[i], g = d[i + 1], b = d[i + 2];
            let luma = 0.299 * r + 0.587 * g + 0.114 * b;

            let maxC = Math.max(r, g, b);
            let minC = Math.min(r, g, b);
            let saturation = maxC > 0 ? (maxC - minC) / maxC : 0;

            let norm = (luma - blackPoint) / range;
            norm = Math.max(0, Math.min(1, norm));

            if (norm > 0.65) {
                let boost = (norm - 0.65) / 0.35;
                let targetLuma = 220 + boost * 35;
                let factor = targetLuma / Math.max(1, luma);
                d[i] = Math.min(255, Math.round(r * factor));
                d[i + 1] = Math.min(255, Math.round(g * factor));
                d[i + 2] = Math.min(255, Math.round(b * factor));
            } else if (norm < 0.35) {
                let darkFactor = 0.65 + norm * 0.35;
                d[i] = Math.round(r * darkFactor);
                d[i + 1] = Math.round(g * darkFactor);
                d[i + 2] = Math.round(b * darkFactor);
            } else {
                let factor = norm > 0.5 ? 1.05 : 0.95;
                d[i] = Math.min(255, Math.max(0, Math.round(r * factor)));
                d[i + 1] = Math.min(255, Math.max(0, Math.round(g * factor)));
                d[i + 2] = Math.min(255, Math.max(0, Math.round(b * factor)));
            }

            // Pertahankan warna stempel merah atau tinta pulpen biru
            if (saturation > 0.25 && norm < 0.85) {
                if (r > g + 25 && r > b + 25) {
                    d[i] = Math.min(255, Math.round(d[i] * 1.2));
                } else if (b > r + 15 && b > g + 15) {
                    d[i + 2] = Math.min(255, Math.round(d[i + 2] * 1.2));
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);
    }

    // ====================================================================
    // 4. ROTASI GAMBAR 90 DERAJAT
    // ====================================================================

    async function rotateImage(dataUrl, degrees = 90) {
        return new Promise((resolve) => {
            let img = new Image();
            img.onload = function () {
                let canvas = document.createElement('canvas');
                let rads = (degrees * Math.PI) / 180;
                let is90or270 = Math.abs(degrees) === 90 || Math.abs(degrees) === 270;

                canvas.width = is90or270 ? img.height : img.width;
                canvas.height = is90or270 ? img.width : img.height;

                let ctx = canvas.getContext('2d');
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.rotate(rads);
                ctx.drawImage(img, -img.width / 2, -img.height / 2);

                let rotatedUrl = canvas.toDataURL('image/jpeg', 0.85);
                resolve({
                    dataUrl: rotatedUrl,
                    base64: rotatedUrl.split(',')[1]
                });
            };
            img.src = dataUrl;
        });
    }

    // ====================================================================
    // 5. PROSES UTAMA SCAN OTOMATIS
    // ====================================================================

    async function processImage(img, options = {}) {
        return new Promise((resolve) => {
            let srcW = img.naturalWidth || img.width;
            let srcH = img.naturalHeight || img.height;

            if (!srcW || !srcH) {
                return resolve({ error: "Dimensi gambar tidak valid" });
            }

            let scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH));
            let targetW = Math.round(srcW * scale);
            let targetH = Math.round(srcH * scale);

            let canvasOri = document.createElement('canvas');
            canvasOri.width = targetW;
            canvasOri.height = targetH;
            let ctxOri = canvasOri.getContext('2d');
            ctxOri.drawImage(img, 0, 0, targetW, targetH);
            let originalDataUrl = canvasOri.toDataURL('image/jpeg', 0.85);

            // Deteksi 4 sudut kemiringan
            let detection = detectDocumentCorners(ctxOri, targetW, targetH);
            let corners = detection.corners;

            let outW, outH;
            if (detection.isDetected) {
                outW = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])));
                outH = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])));
            } else {
                outW = targetW;
                outH = targetH;
            }

            // Meluruskan sudut (Perspective Dewarp)
            let canvasWarped = warpPerspective(canvasOri, corners, outW, outH);

            // Terapkan filter pemutih & penajam
            let ctxWarp = canvasWarped.getContext('2d');
            applyMagicScanFilter(ctxWarp, outW, outH);

            let scannedDataUrl = canvasWarped.toDataURL('image/jpeg', 0.80);

            resolve({
                scannedDataUrl: scannedDataUrl,
                originalDataUrl: originalDataUrl,
                base64Scanned: scannedDataUrl.split(',')[1],
                base64Original: originalDataUrl.split(',')[1],
                didCrop: detection.isDetected,
                corners: corners,
                width: targetW,
                height: targetH
            });
        });
    }

    // ====================================================================
    // 6. MODAL INTERAKTIF CROP MANUAL (TOUCH & MOUSE 4-CORNER)
    // ====================================================================

    let activeCropState = null;

    function bukaModalCropManual(targetType, onDoneCallback) {
        let cacheObj = (targetType === 'SJ') ? window._scanCacheSJ : window._scanCacheCF;
        if (!cacheObj || !cacheObj.originalDataUrl) {
            alert("Pilih foto terlebih dahulu!");
            return;
        }

        let modal = document.getElementById('modal-scanner-crop-manual');
        if (!modal) {
            buatElementModalCrop();
            modal = document.getElementById('modal-scanner-crop-manual');
        }

        activeCropState = {
            targetType: targetType,
            onDone: onDoneCallback,
            originalDataUrl: cacheObj.originalDataUrl,
            img: new Image(),
            corners: cacheObj.corners ? JSON.parse(JSON.stringify(cacheObj.corners)) : null,
            activeCornerIdx: -1,
            scaleCanvas: 1
        };

        activeCropState.img.onload = function () {
            initCanvasCropInteractive();
            modal.style.display = 'flex';
        };
        activeCropState.img.src = cacheObj.originalDataUrl;
    }

    function tutupModalCropManual() {
        let modal = document.getElementById('modal-scanner-crop-manual');
        if (modal) modal.style.display = 'none';
        activeCropState = null;
    }

    function initCanvasCropInteractive() {
        let canvas = document.getElementById('canvas-crop-interactive');
        if (!canvas || !activeCropState) return;

        let img = activeCropState.img;
        let maxDisplayW = Math.min(window.innerWidth - 30, 480);
        let maxDisplayH = Math.min(window.innerHeight - 200, 520);

        let scale = Math.min(maxDisplayW / img.width, maxDisplayH / img.height);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        activeCropState.scaleCanvas = scale;

        // Inisialisasi 4 sudut jika belum ada
        if (!activeCropState.corners || activeCropState.corners.length !== 4) {
            let padX = Math.round(img.width * 0.05);
            let padY = Math.round(img.height * 0.05);
            activeCropState.corners = [
                { x: padX, y: padY },
                { x: img.width - padX, y: padY },
                { x: img.width - padX, y: img.height - padY },
                { x: padX, y: img.height - padY }
            ];
        }

        pasangEventCanvasTouch(canvas);
        gambarCanvasCrop();
    }

    function gambarCanvasCrop() {
        let canvas = document.getElementById('canvas-crop-interactive');
        if (!canvas || !activeCropState) return;
        let ctx = canvas.getContext('2d');
        let img = activeCropState.img;
        let s = activeCropState.scaleCanvas;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        let c = activeCropState.corners.map(pt => ({ x: pt.x * s, y: pt.y * s }));

        // Garis batas dokumen
        ctx.beginPath();
        ctx.moveTo(c[0].x, c[0].y);
        ctx.lineTo(c[1].x, c[1].y);
        ctx.lineTo(c[2].x, c[2].y);
        ctx.lineTo(c[3].x, c[3].y);
        ctx.closePath();

        // Shading di luar dokumen
        ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.moveTo(c[0].x, c[0].y);
        ctx.lineTo(c[1].x, c[1].y);
        ctx.lineTo(c[2].x, c[2].y);
        ctx.lineTo(c[3].x, c[3].y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Garis border hijau tajam
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#16a34a';
        ctx.stroke();

        // Titik lingkaran handle sudut
        c.forEach((pt, idx) => {
            let isActive = (activeCropState.activeCornerIdx === idx);

            if (isActive) {
                // Efek glow saat disentuh / digeser
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 24, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(22, 163, 74, 0.35)';
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(pt.x, pt.y, isActive ? 16 : 13, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = isActive ? '#15803d' : '#16a34a';
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(pt.x, pt.y, isActive ? 5 : 4, 0, Math.PI * 2);
            ctx.fillStyle = '#16a34a';
            ctx.fill();
        });
    }

    function pasangEventCanvasTouch(canvas) {
        if (canvas._hasCropEvents) return;
        canvas._hasCropEvents = true;

        function getPos(e) {
            let rect = canvas.getBoundingClientRect();
            let clientX = e.touches ? e.touches[0].clientX : e.clientX;
            let clientY = e.touches ? e.touches[0].clientY : e.clientY;
            return {
                x: (clientX - rect.left) / activeCropState.scaleCanvas,
                y: (clientY - rect.top) / activeCropState.scaleCanvas
            };
        }

        function onStart(e) {
            if (!activeCropState) return;
            let pos = getPos(e);
            let s = activeCropState.scaleCanvas;
            let threshold = 50 / s; // 50px radius ramah jari mobile
            let foundIdx = -1;
            let minDist = Infinity;

            activeCropState.corners.forEach((pt, idx) => {
                let d = dist(pos, pt);
                if (d < threshold && d < minDist) {
                    minDist = d;
                    foundIdx = idx;
                }
            });

            activeCropState.activeCornerIdx = foundIdx;
            if (foundIdx !== -1) {
                if (e.cancelable) e.preventDefault();
                gambarCanvasCrop();
            }
        }

        function onMove(e) {
            if (!activeCropState || activeCropState.activeCornerIdx === -1) return;
            if (e.cancelable) e.preventDefault();
            let pos = getPos(e);
            let img = activeCropState.img;
            let idx = activeCropState.activeCornerIdx;

            activeCropState.corners[idx].x = Math.max(0, Math.min(img.width, pos.x));
            activeCropState.corners[idx].y = Math.max(0, Math.min(img.height, pos.y));
            gambarCanvasCrop();
        }

        function onEnd(e) {
            if (activeCropState && activeCropState.activeCornerIdx !== -1) {
                activeCropState.activeCornerIdx = -1;
                gambarCanvasCrop();
            }
        }

        canvas.addEventListener('mousedown', onStart);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onEnd);

        canvas.addEventListener('touchstart', onStart, { passive: false });
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
    }

    async function terapkanCropManual() {
        if (!activeCropState) return;
        let img = activeCropState.img;
        let corners = activeCropState.corners;

        let outW = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])));
        let outH = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])));

        let canvasOri = document.createElement('canvas');
        canvasOri.width = img.width;
        canvasOri.height = img.height;
        let ctxOri = canvasOri.getContext('2d');
        ctxOri.drawImage(img, 0, 0);

        let canvasWarped = warpPerspective(canvasOri, corners, outW, outH);
        let ctxWarp = canvasWarped.getContext('2d');
        applyMagicScanFilter(ctxWarp, outW, outH);

        let scannedDataUrl = canvasWarped.toDataURL('image/jpeg', 0.80);
        let result = {
            scannedDataUrl: scannedDataUrl,
            base64Scanned: scannedDataUrl.split(',')[1],
            originalDataUrl: activeCropState.originalDataUrl,
            corners: corners
        };

        if (typeof activeCropState.onDone === 'function') {
            activeCropState.onDone(result);
        }

        tutupModalCropManual();
    }

    async function putarOriginalDalamModal(degrees = 90) {
        if (!activeCropState) return;
        let res = await rotateImage(activeCropState.originalDataUrl, degrees);
        activeCropState.originalDataUrl = res.dataUrl;
        activeCropState.img = new Image();
        activeCropState.corners = null; // Reset corners agar re-detect
        activeCropState.img.onload = function () {
            initCanvasCropInteractive();
        };
        activeCropState.img.src = res.dataUrl;
    }

    function buatElementModalCrop() {
        let div = document.createElement('div');
        div.id = 'modal-scanner-crop-manual';
        div.style.cssText = `
            position: fixed; inset: 0; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px);
            z-index: 999999; display: none; flex-direction: column; align-items: center; justify-content: center;
            padding: 10px; font-family: 'Poppins', sans-serif;
        `;
        div.innerHTML = `
            <div style="background: #ffffff; border-radius: 14px; max-width: 520px; width: 100%; max-height: 94vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
                <div style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; background:#f8fafc;">
                    <div style="font-weight: 800; font-size: 13px; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                        <span class="material-symbols-outlined" style="font-size: 18px; color: #16a34a;">crop</span>
                        Atur Sudut & Kemiringan Dokumen
                    </div>
                    <button type="button" onclick="CBLDocScanner.tutupModalCropManual()" style="background: none; border: none; cursor: pointer; color: #64748b;">
                        <span class="material-symbols-outlined" style="font-size: 20px;">close</span>
                    </button>
                </div>
                
                <div style="padding: 6px 12px; background: #eff6ff; font-size: 10.5px; color: #1e40af; text-align: center; border-bottom: 1px solid #bfdbfe;">
                    👆 <b>Trik:</b> Tarik 4 bulatan hijau ke sudut nota/kwitansi untuk meluruskan miring.
                </div>

                <div style="flex: 1; display: flex; align-items: center; justify-content: center; padding: 10px; background: #0f172a; overflow: hidden;">
                    <canvas id="canvas-crop-interactive" style="border-radius: 6px; box-shadow: 0 4px 10px rgba(0,0,0,0.4); touch-action: none;"></canvas>
                </div>

                <div style="padding: 10px 14px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; flex-direction: column; gap: 8px;">
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button type="button" onclick="CBLDocScanner.putarOriginalDalamModal(90)" style="flex: 1; background: #ffffff; color: #334155; border: 1px solid #cbd5e1; padding: 8px; border-radius: 8px; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px;">
                            <span class="material-symbols-outlined" style="font-size: 16px;">rotate_right</span> Putar 90°
                        </button>
                        <button type="button" onclick="CBLDocScanner.resetCropPenuh()" style="flex: 1; background: #ffffff; color: #334155; border: 1px solid #cbd5e1; padding: 8px; border-radius: 8px; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px;">
                            <span class="material-symbols-outlined" style="font-size: 16px;">aspect_ratio</span> Reset Penuh
                        </button>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button type="button" onclick="CBLDocScanner.tutupModalCropManual()" style="flex: 1; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; padding: 10px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer;">
                            Batal
                        </button>
                        <button type="button" onclick="CBLDocScanner.terapkanCropManual()" style="flex: 2; background: #16a34a; color: #ffffff; border: none; padding: 10px; border-radius: 8px; font-size: 12px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; box-shadow: 0 4px 6px -1px rgba(22, 163, 74, 0.3);">
                            <span class="material-symbols-outlined" style="font-size: 16px;">check</span> Luruskan & Scan
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(div);
    }

    function resetCropPenuh() {
        if (!activeCropState) return;
        let img = activeCropState.img;
        activeCropState.corners = [
            { x: 0, y: 0 },
            { x: img.width, y: 0 },
            { x: img.width, y: img.height },
            { x: 0, y: img.height }
        ];
        gambarCanvasCrop();
    }

    return {
        processImage: processImage,
        rotateImage: rotateImage,
        warpPerspective: warpPerspective,
        applyMagicScanFilter: applyMagicScanFilter,
        bukaModalCropManual: bukaModalCropManual,
        tutupModalCropManual: tutupModalCropManual,
        terapkanCropManual: terapkanCropManual,
        putarOriginalDalamModal: putarOriginalDalamModal,
        resetCropPenuh: resetCropPenuh
    };
})();
