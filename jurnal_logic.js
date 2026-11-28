// ==========================================
// LOGIKA JURNAL UMUM (DOUBLE-ENTRY)
// Mengambil data dari view_jurnal_umum
// ==========================================

let jurnalDataGlobal = [];
let jurnalNotaItemsGlobal = {};

function normalizeTglToIso(tglStr) {
    if (!tglStr) return '';
    let s = String(tglStr).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        let p = s.split('/');
        return `${p[2]}-${p[1]}-${p[0]}`;
    }
    return s;
}

function formatTglIndoShort(tglStr) {
    let iso = normalizeTglToIso(tglStr);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        return iso.split('-').reverse().join('/');
    }
    return tglStr || '-';
}

function formatDetailPotonganNota(detailPotongan, nf, notaLookupMap = null, relasi = '') {
    if (!detailPotongan || detailPotongan.length === 0) return '';
    return detailPotongan.map(p => {
        let tglDisp = formatTglIndoShort(p.tglNota);
        let items = (p.items && p.items.length > 0) ? p.items : null;
        if (!items && notaLookupMap && relasi) {
            let iso = normalizeTglToIso(p.tglNota);
            let key = `${relasi.toLowerCase().trim()}|${iso}`;
            if (notaLookupMap[key] && notaLookupMap[key].length > 0) {
                items = notaLookupMap[key];
            }
        }

        if (items && items.length > 0) {
            let totalNotaItems = items.reduce((s, it) => s + (Number(it.nominal) || 0), 0);
            let rincianStr = items.map(it => {
                let qtyNum = Number(it.qty) || 0;
                let nomNum = Number(it.nominal) || 0;
                let hsNum = Number(it.harga_satuan) || (qtyNum > 0 ? Math.round(nomNum / qtyNum) : 0);
                let qPart = qtyNum > 0 ? ` ${nf.format(qtyNum)} ${it.satuan || 'Kg'}` : '';
                let hPart = hsNum > 0 ? ` @Rp ${nf.format(hsNum)}` : '';
                return `${it.pakan}${qPart}${hPart} = Rp ${nf.format(nomNum)}`;
            }).join('; ');

            if (totalNotaItems > 0 && Math.abs(p.jumlah - totalNotaItems) > 100) {
                return `Nota ${tglDisp} (${rincianStr} | Potong: Rp ${nf.format(p.jumlah)})`;
            }
            return `Nota ${tglDisp} (${rincianStr})`;
        }
        return `Nota ${tglDisp} (Rp ${nf.format(p.jumlah)})`;
    }).join('; ');
}

function formatDeskripsiNominal(deskripsi, nf) {
    if (!deskripsi) return "";
    let nfQty = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
    let out = String(deskripsi).replace(/(@|Rp\s*)(\d{1,3}(?:\.\d{3})+(?!\d)|\d+(?:\.\d+)?)/g, (match, prefix, numStr) => {
        if (/^\d{1,3}(\.\d{3})+$/.test(numStr)) {
            return prefix + nf.format(Number(numStr.replace(/\./g, '')));
        }
        let num = Number(numStr);
        if (isNaN(num)) return match;
        return prefix + nf.format(Math.round(num));
    });
    out = out.replace(/(\b\d{1,3}(?:\.\d{3})+|\b\d+(?:\.\d+)?)\s*(Kg|Ltr|Liter|Rit|Ekor|Sak|Karung)\b/gi, (match, numStr, unit) => {
        if (/^\d{1,3}(\.\d{3})+$/.test(numStr)) {
            return `${nfQty.format(Number(numStr.replace(/\./g, '')))} ${unit}`;
        }
        let num = Number(numStr);
        if (isNaN(num)) return match;
        return `${nfQty.format(num)} ${unit}`;
    });
    return out;
}

function relasiIncludes(dRelasi, zRelasi) {
    if (!dRelasi || !zRelasi) return false;
    let target = String(zRelasi).trim().toLowerCase();
    let tokens = String(dRelasi).split(',').map(s => s.trim().toLowerCase());
    return tokens.includes(target);
}

function appendRelasiToGroup(dRelasi, zRelasi) {
    if (!zRelasi) return dRelasi || '';
    if (!dRelasi) return zRelasi;
    if (relasiIncludes(dRelasi, zRelasi)) return dRelasi;
    return `${dRelasi}, ${zRelasi}`;
}

const EXACT_KELOMPOK_TERNAK_SET = new Set([
    'kapalang', 'dewasa', 'pedet', 'pedet pm', 'pedet spn',
    'jantan', 'bx', 'domba', 'kambing', 'transit', 'potong',
    'laktasi', 'bunting', 'darbun', 'dara', 'perah', 'kerbau',
    'rl', 'rd', 'sapi transit', 'sapi potong', 'sapi perah',
    'sapi campur', 'cibulakan'
]);

function isMasterKonsumenJurnal(relasi) {
    let rel = String(relasi || '').trim().toLowerCase();
    if (!rel) return false;
    if (typeof globalRelasi !== 'undefined' && Array.isArray(globalRelasi)) {
        let m = globalRelasi.find(r => String(r.nama || '').trim().toLowerCase() === rel);
        if (m && m.kategori) {
            let kat = String(m.kategori).trim().toLowerCase();
            if (kat === 'konsumen' || kat === 'peternak' || kat === 'mitra') return true;
        }
    }
    return false;
}

function isKelompokTernakRelasi(relasi, pakan = '') {
    let rel = String(relasi || '').trim().toLowerCase();
    if (!rel) return false;
    if (isMasterKonsumenJurnal(rel)) return false;
    let pkn = String(pakan || '').trim().toLowerCase();
    if (EXACT_KELOMPOK_TERNAK_SET.has(rel)) return true;
    if (rel.startsWith('sapi ') && (rel.includes('transit') || rel.includes('potong') || rel.includes('perah') || rel.includes('campur'))) return true;
    if ((rel === 'spn' || rel.startsWith('kandang')) && (pkn.includes('laktasi') || pkn.includes('darbun'))) return true;
    return false;
}

function isPakanGilingJadi(pakanName) {
    let p = String(pakanName || '').trim().toLowerCase();
    return p.includes('ransum laktasi') || p.includes('ransum darbun') || p === 'rl' || p === 'rd';
}

function getEffectiveHppWithGiling(rawTotalHpp, qty, pakanName, fallbackUnitHpp = 0, hargaSatuan = 0) {
    let q = Number(qty) || 0;
    let h = Number(rawTotalHpp) || 0;
    let isGiling = isPakanGilingJadi(pakanName);
    if (q <= 0) return { totalHpp: h, unitHpp: 0, isEstimasi: false, hasGilingCost: false };

    if (h > 0) {
        let upah = isGiling ? Math.round(q * 100) : 0;
        let tot = h + upah;
        return { totalHpp: tot, unitHpp: Math.round(tot / q), isEstimasi: false, hasGilingCost: isGiling };
    }

    let unitRaw = fallbackUnitHpp > 0 ? Math.round(fallbackUnitHpp) : (hargaSatuan > 0 ? Math.round(hargaSatuan * 0.85) : 0);
    if (unitRaw > 0) {
        let unitEff = isGiling ? (unitRaw + 100) : unitRaw;
        return { totalHpp: Math.round(q * unitEff), unitHpp: unitEff, isEstimasi: true, hasGilingCost: isGiling };
    }
    return { totalHpp: 0, unitHpp: 0, isEstimasi: false, hasGilingCost: false };
}

function isLogistikTransferShared(t) {
    let rel = (t.relasi || '').trim().toLowerCase();
    let cat = (t.catatan || '').toLowerCase();
    if (['kandang', 'kandang pm', 'kandang spn', 'kandang rph', 'spn', 'pm', 'rph', 'mutasi'].includes(rel)) return true;
    if (rel === 'pembibitan' || rel.includes('pembibitan') || rel === 'cibulakan' || rel.includes('cibulakan')) return true;
    if (cat.includes('[auto mutasi]') || cat.includes('kiriman dari') || cat.includes('mutasi antar gudang') || cat.includes('mutasi internal')) return true;
    return false;
}

function isBahanBakuGilinganShared(t) {
    let cab = (t.cabang || '').trim().toUpperCase();
    let rel = (t.relasi || '').trim().toUpperCase();
    let cat = (t.catatan || '').toLowerCase();
    if (cab.includes('SPN') && !cab.includes('KANDANG')) {
        if (rel === 'RL' || rel === 'RD' || rel === 'DARBUN' || rel === 'LAKTASI' || rel.includes('GILING') || cat.includes('giling')) {
            return true;
        }
    }
    return false;
}

function classifyKonsumsiTernakBranch(t) {
    if (isLogistikTransferShared(t) || isBahanBakuGilinganShared(t)) return null;
    let rel = (t.relasi || '').trim();
    let relLower = rel.toLowerCase();
    let cab = (t.cabang || '').trim().toLowerCase();
    let pkn = (t.pakan || '').trim().toLowerCase();
    if (pkn.includes('ongkir')) return null;

    let isCabKandang = cab.includes('kandang') && !isMasterKonsumenJurnal(rel);
    if (!isCabKandang && !isKelompokTernakRelasi(rel, pkn)) return null;

    if (cab.includes('spn')) {
        if (relLower === 'kandang' || relLower === 'spn' || relLower === 'pembibitan') return null;
        let unit = relLower.includes('laktasi') || relLower === 'rl' || pkn.includes('laktasi') ? 'Laktasi (RL)'
                 : (relLower.includes('bunting') || relLower.includes('darbun') || relLower === 'rd' || pkn.includes('darbun') ? 'Bunting / Dara (RD)'
                 : (relLower.includes('pedet') ? 'Pedet SPN' : 'Sapi Perah (SPN)'));
        return { cabangKey: 'SPN', unit };
    }
    if (cab === 'rph' || cab.includes('rph')) {
        if (relLower === 'kandang' || relLower === 'rph' || relLower === 'pembibitan') return null;
        let unit = relLower.includes('jantan') ? 'Jantan'
                 : (relLower.includes('bx') ? 'BX'
                 : (relLower.includes('domba') ? 'Domba'
                 : (relLower.includes('kambing') ? 'Kambing'
                 : (relLower.includes('transit') || relLower.includes('potong') ? 'Sapi Transit / Potong' : rel))));
        return { cabangKey: 'RPH', unit };
    }
    if (cab === 'pm' || cab.includes('pm') || (cab.includes('kandang') && !cab.includes('spn') && !cab.includes('rph'))) {
        if (relLower === 'kandang' || relLower === 'pm' || relLower === 'pembibitan') return null;
        let unit = relLower.includes('kapalang') ? 'Kapalang'
                 : (relLower.includes('dewasa') ? 'Dewasa'
                 : (relLower.includes('pedet') ? 'Pedet PM'
                 : (relLower.includes('jantan') ? 'Jantan' : rel)));
        return { cabangKey: 'PM', unit };
    }

    if (relLower.includes('laktasi') || relLower.includes('bunting') || relLower.includes('darbun') || relLower.includes('perah') || relLower === 'rl' || relLower === 'rd' || pkn.includes('laktasi') || pkn.includes('darbun')) {
        let unit = (relLower.includes('laktasi') || relLower === 'rl' || pkn.includes('laktasi')) ? 'Laktasi (RL)'
                 : ((relLower.includes('bunting') || relLower.includes('darbun') || relLower === 'rd' || pkn.includes('darbun')) ? 'Bunting / Dara (RD)' : 'Sapi Perah (SPN)');
        return { cabangKey: 'SPN', unit };
    }
    if (['jantan', 'bx', 'domba', 'kambing', 'transit', 'potong'].some(k => relLower.includes(k))) {
        let unit = relLower.includes('jantan') ? 'Jantan' : (relLower.includes('bx') ? 'BX' : (relLower.includes('domba') ? 'Domba' : (relLower.includes('kambing') ? 'Kambing' : 'Sapi Transit / Potong')));
        return { cabangKey: 'RPH', unit };
    }
    if (['kapalang', 'dewasa', 'pedet'].some(k => relLower.includes(k))) {
        let unit = relLower.includes('kapalang') ? 'Kapalang' : (relLower.includes('dewasa') ? 'Dewasa' : 'Pedet PM');
        return { cabangKey: 'PM', unit };
    }
    return null;
}

function escapeRegexJurnal(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function injectEstimasiIntoRow(row, z) {
    if (!row._estTokens) row._estTokens = [];
    let idx = row._estTokens.length;
    let placeholder = `%%EST_TOKEN_${idx}%%`;
    let tagText = `x @${z._estUnitHpp} [HPP ESTIMASI SEMENTARA]`;

    let desc = row.deskripsi || '';
    let pknEsc = escapeRegexJurnal(z.pakan);
    let qtyEsc = escapeRegexJurnal(String(z.qty));
    let satEsc = escapeRegexJurnal(z.satuan || 'Kg');
    let relEsc = escapeRegexJurnal(z.relasi || '');

    let itemRx = new RegExp(`(${pknEsc}\\s+${qtyEsc}\\b(?:\\s+(?:${satEsc}|[A-Za-z]+)\\b)?)(?!\\s*x\\s*@)`, 'i');

    if (z.relasi) {
        let blockRx = new RegExp(`(${relEsc}\\s*\\([^;]*?)(;|$)`, 'i');
        let bMatch = desc.match(blockRx);
        if (bMatch && itemRx.test(bMatch[1])) {
            let updatedBlock = bMatch[1].replace(itemRx, (m, g1) => {
                row._estTokens.push(`${g1} ${tagText}`);
                return placeholder;
            });
            row.deskripsi = desc.replace(blockRx, updatedBlock + bMatch[2]);
            return;
        }
    }

    if (itemRx.test(desc)) {
        row.deskripsi = desc.replace(itemRx, (m, g1) => {
            row._estTokens.push(`${g1} ${tagText}`);
            return placeholder;
        });
        return;
    }

    row._estTokens.push(`${z.pakan} ${z.qty} ${z.satuan || 'Kg'} ${tagText}`);
    if (z.relasi && new RegExp(`${relEsc}\\s*\\(`, 'i').test(desc)) {
        let appendInBlockRx = new RegExp(`(${relEsc}\\s*\\([^;]*?)(;|$)`, 'i');
        row.deskripsi = desc.replace(appendInBlockRx, `$1 + (${placeholder})$2`);
    } else {
        row.deskripsi = (desc ? desc + '; ' : '') + `${z.relasi} (${placeholder})`;
    }
}

/**
 * Helper terpusat untuk menarik seluruh baris Supabase tanpa batas 1.000 baris,
 * fallback ke fetch standar jika dipanggil terisolasi tanpa fetchSupabaseAll atau bila URL memiliki limit=.
 */
async function fetchJurnalPaged(url, headers) {
    if (url.includes('limit=')) {
        let res = await fetch(url, { headers });
        if (!res.ok) {
            let errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.message || `HTTP ${res.status}`);
        }
        let data = await res.json();
        return Array.isArray(data) ? data : [];
    }

    const limit = 1000;
    const sep = url.includes('?') ? '&' : '?';
    const firstRes = await fetch(`${url}${sep}offset=0&limit=${limit}`, {
        headers: { ...headers, 'Prefer': 'count=exact' }
    });
    if (!firstRes.ok) {
        let errBody = await firstRes.json().catch(() => ({}));
        throw new Error(errBody.message || `HTTP ${firstRes.status}`);
    }
    const firstRows = await firstRes.json();
    if (!Array.isArray(firstRows)) return [];
    if (firstRows.length < limit) return firstRows;

    const rangeHdr = firstRes.headers && typeof firstRes.headers.get === 'function' ? firstRes.headers.get('content-range') : null;
    const totalMatch = rangeHdr ? rangeHdr.match(/\/(\d+)$/) : null;
    const totalCount = totalMatch ? parseInt(totalMatch[1], 10) : null;

    if (totalCount && totalCount > limit) {
        let offsets = [];
        for (let off = limit; off < totalCount; off += limit) offsets.push(off);
        let all = firstRows.slice();
        for (let i = 0; i < offsets.length; i += 4) {
            let chunk = offsets.slice(i, i + 4);
            let pages = await Promise.all(chunk.map(async (off) => {
                let r = await fetch(`${url}${sep}offset=${off}&limit=${limit}`, { headers });
                if (!r.ok) {
                    let errBody = await r.json().catch(() => ({}));
                    throw new Error(errBody.message || `HTTP ${r.status}`);
                }
                let rows = await r.json();
                return Array.isArray(rows) ? rows : [];
            }));
            pages.forEach(p => { all = all.concat(p); });
        }
        return all;
    }

    let fnFetch = (typeof fetchSupabaseAll === 'function')
        ? fetchSupabaseAll
        : (typeof window !== 'undefined' && typeof window.fetchSupabaseAll === 'function' ? window.fetchSupabaseAll : null);
    if (fnFetch) {
        let all = firstRows.slice();
        let offset = limit;
        let keep = true;
        while (keep) {
            let r = await fetch(`${url}${sep}offset=${offset}&limit=${limit}`, { headers });
            if (!r.ok) {
                let errBody = await r.json().catch(() => ({}));
                throw new Error(errBody.message || `HTTP ${r.status}`);
            }
            let page = await r.json();
            if (!Array.isArray(page) || page.length === 0) break;
            all = all.concat(page);
            if (page.length < limit) keep = false;
            else offset += limit;
        }
        return all;
    }
    return firstRows;
}

async function fetchDataJurnal(silent = false) {
    let bulan = document.getElementById('jurnal-bulan').value;
    let tahun = document.getElementById('jurnal-tahun').value;
    
    let start, end;
    if (bulan === 'ALL') {
        start = `${tahun}-01-01`;
        end = `${tahun}-12-31`;
    } else {
        start = `${tahun}-${bulan}-01`;
        // Mencari hari terakhir di bulan tsb
        let lastDay = new Date(tahun, Number(bulan), 0).getDate();
        end = `${tahun}-${bulan}-${lastDay}`;
    }

    if (!silent) {
        document.getElementById('jurnal-loader').classList.remove('hidden');
        document.getElementById('tbody-jurnal').innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:#888;">Memuat data jurnal...</td></tr>`;
    }

    try {
        let headers = {
            'apikey': SUPA_ANON_KEY,
            'Authorization': `Bearer ${SUPA_ANON_KEY}`
        };

        let urlJurnal = `${SUPA_URL}/rest/v1/view_jurnal_umum?tanggal=gte.${start}&tanggal=lte.${end}&order=tanggal.asc,id_jurnal.asc`;
        let urlTrx = `${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=gte.${start}&tanggal=lte.${end}&status=ilike.*keluar*&select=id,tanggal,cabang,relasi,pakan,qty,satuan,harga_satuan,total_hpp,catatan,hash_str&order=tanggal.asc,id.asc`;
        let urlBatch = `${SUPA_URL}/rest/v1/stok_batch?order=tanggal_masuk.desc,id.desc&limit=1500&select=pakan,hpp`;

        let [data, trxOut, batchList] = await Promise.all([
            fetchJurnalPaged(urlJurnal, headers),
            fetchJurnalPaged(urlTrx, headers).catch(() => []),
            fetchJurnalPaged(urlBatch, headers).catch(() => [])
        ]);

        // 1. Bangun map rincian item nota (relasi|tanggal -> items[]) agar deskripsi pelunasan selalu rinci
        let notaMap = {};
        // 2. Bangun fallback harga HPP dari batch gudang terbaru
        let fallbackHppMap = {};
        (batchList || []).forEach(b => {
            let pkn = (b.pakan || '').trim();
            let uHpp = Number(b.hpp) || 0;
            if (uHpp > 0 && pkn && !fallbackHppMap[pkn]) fallbackHppMap[pkn] = uHpp;
        });

        let zeroHppTrxList = [];
        let monthlyKandangMap = {}; // monthKey|cabangKey -> agregasi pemakaian kandang akhir bulan
        let bahanBakuGilingMap = {}; // tanggal|RANSUM LAKTASI / RANSUM DARBUN / ALL -> rincian bahan baku + HPP

        (trxOut || []).forEach(t => {
            let rel = (t.relasi || '').trim();
            let pkn = (t.pakan || '').trim();
            let qty = Number(t.qty) || 0;
            let hs = Number(t.harga_satuan) || 0;
            let hpp = Number(t.total_hpp) || 0;
            let nom = qty * hs;

            if (rel && t.tanggal && (nom > 0 || qty > 0)) {
                let key = `${rel.toLowerCase()}|${t.tanggal}`;
                if (!notaMap[key]) notaMap[key] = [];
                notaMap[key].push({
                    pakan: pkn,
                    qty: qty,
                    satuan: pkn.toLowerCase().includes('ongkir') ? 'Rit' : (t.satuan || 'Kg'),
                    harga_satuan: hs,
                    nominal: nom
                });
            }

            if (isBahanBakuGilinganShared(t) && !isPakanGilingJadi(pkn) && !pkn.toLowerCase().includes('ongkir') && qty > 0 && t.tanggal) {
                let relL = rel.toLowerCase();
                let catL = (t.catatan || '').toLowerCase();
                let gilingTarget = (relL === 'rl' || relL.startsWith('rl ') || relL.includes('laktasi') || catL.includes('laktasi') || /\brl\b/.test(catL))
                    ? 'RANSUM LAKTASI'
                    : ((relL === 'rd' || relL.startsWith('rd ') || relL.includes('darbun') || catL.includes('darbun') || /\brd\b/.test(catL))
                        ? 'RANSUM DARBUN'
                        : 'ALL');
                let effIng = getEffectiveHppWithGiling(hpp, qty, pkn, fallbackHppMap[pkn] || 0, hs);
                let gKey = `${t.tanggal}|${gilingTarget}`;
                if (!bahanBakuGilingMap[gKey]) bahanBakuGilingMap[gKey] = {};
                let itemKey = `${pkn}|${effIng.unitHpp}|${effIng.isEstimasi ? '1' : '0'}`;
                if (!bahanBakuGilingMap[gKey][itemKey]) {
                    bahanBakuGilingMap[gKey][itemKey] = {
                        pakan: pkn,
                        satuan: t.satuan || 'Kg',
                        qty: 0,
                        unitHpp: effIng.unitHpp,
                        totalHpp: 0,
                        isEstimasi: effIng.isEstimasi
                    };
                }
                bahanBakuGilingMap[gKey][itemKey].qty += qty;
                bahanBakuGilingMap[gKey][itemKey].totalHpp += effIng.totalHpp;
                return;
            }

            if (isLogistikTransferShared(t) || isBahanBakuGilinganShared(t)) return;
            let isOngkir = pkn.toLowerCase().includes('ongkir');
            if (isOngkir || qty <= 0) return;

            let ternakInfo = classifyKonsumsiTernakBranch(t);
            let eff = getEffectiveHppWithGiling(hpp, qty, pkn, fallbackHppMap[pkn] || 0, hs);

            if (ternakInfo) {
                // Kumpulkan untuk Rekap Pemakaian Kandang Akhir Bulan (1 baris per cabang, per kelompok sapi, per beda HPP)
                let mKey = String(t.tanggal).slice(0, 7);
                let bKey = `${mKey}|${ternakInfo.cabangKey}`;
                if (!monthlyKandangMap[bKey]) {
                    let [yr, mo] = mKey.split('-').map(Number);
                    let lastD = new Date(yr, mo, 0).getDate();
                    monthlyKandangMap[bKey] = {
                        monthEndDate: `${mKey}-${('0' + lastD).slice(-2)}`,
                        cabangKey: ternakInfo.cabangKey,
                        units: {},
                        totalHpp: 0,
                        hasEstimasi: false
                    };
                }
                let grpBranch = monthlyKandangMap[bKey];
                if (!grpBranch.units[ternakInfo.unit]) grpBranch.units[ternakInfo.unit] = {};
                let itemKey = `${pkn}|${eff.unitHpp}|${eff.isEstimasi ? '1' : '0'}`;
                if (!grpBranch.units[ternakInfo.unit][itemKey]) {
                    grpBranch.units[ternakInfo.unit][itemKey] = {
                        pakan: pkn,
                        satuan: t.satuan || 'Kg',
                        unitHpp: eff.unitHpp,
                        isEstimasi: eff.isEstimasi,
                        qty: 0,
                        totalHpp: 0
                    };
                }
                grpBranch.units[ternakInfo.unit][itemKey].qty += qty;
                grpBranch.units[ternakInfo.unit][itemKey].totalHpp += eff.totalHpp;
                grpBranch.totalHpp += eff.totalHpp;
                if (eff.isEstimasi) grpBranch.hasEstimasi = true;
            } else if (hpp === 0 && eff.unitHpp > 0) {
                // Penjualan komersial yang HPP-nya masih 0
                zeroHppTrxList.push({
                    ...t,
                    _isInternalKandang: false,
                    _estUnitHpp: eff.unitHpp,
                    _estTotalHpp: eff.totalHpp
                });
            }
        });
        jurnalNotaItemsGlobal = notaMap;

        // 2B. Transformasi Konversi Gilingan SPN (+Rp 100/Kg Upah Giling -> Hutang Upah Giling),
        // Reklasifikasi pembayaran cashflow "Upah Giling" ke pelunasan Hutang Upah Giling,
        // serta bersihkan baris harian Pemakaian Pakan Kandang agar diganti Rekap Akhir Bulan
        let nfLocal = new Intl.NumberFormat('id-ID');
        let nfQtyLocal = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
        let formatRincianBahanGiling = (tanggal, descLower) => {
            let targetKey = descLower.includes('laktasi')
                ? `${tanggal}|RANSUM LAKTASI`
                : (descLower.includes('darbun') ? `${tanggal}|RANSUM DARBUN` : `${tanggal}|ALL`);
            let mapItems = bahanBakuGilingMap[targetKey] || bahanBakuGilingMap[`${tanggal}|ALL`] || null;
            if (!mapItems) return '';
            let items = Object.values(mapItems);
            if (items.length === 0) return '';
            return items.map(it => {
                let qtyStr = `${nfQtyLocal.format(it.qty)} ${it.satuan}`;
                if (it.totalHpp > 0 || it.unitHpp > 0) {
                    let estTag = it.isEstimasi ? ' [Estimasi]' : '';
                    return `${it.pakan} ${qtyStr} x @${nfLocal.format(it.unitHpp)} (Rp ${nfLocal.format(Math.round(it.totalHpp))})${estTag}`;
                }
                return `${it.pakan} ${qtyStr}`;
            }).join(' + ');
        };
        let sqlSudahHandleGiling = (data || []).some(r =>
            String(r.id_jurnal || '').startsWith('TP-GIL-') ||
            (r.nama_akun || '').trim() === 'Hutang Upah Giling'
        );
        let removedPemakaianKeys = new Set();
        (data || []).forEach(d => {
            if ((d.nama_akun || '').toLowerCase().includes('pemakaian pakan')) {
                removedPemakaianKeys.add(`${d.tanggal}|${Number(d.debit) || 0}`);
            }
        });

        let cleanedData = [];
        (data || []).forEach(rawRow => {
            let d = { ...rawRow };
            let nama = (d.nama_akun || '').trim();
            let desc = d.deskripsi || '';
            let descL = desc.toLowerCase();
            let relU = (d.relasi || '').trim().toUpperCase();
            let isMutasiRow = String(d.id_jurnal || '').startsWith('TP-MUT-') || String(d.referensi || '').toLowerCase().includes('mutasi');

            // Hapus baris harian Pemakaian Pakan Kandang (digantikan rekap akhir bulan per cabang)
            if (nama.toLowerCase().includes('pemakaian pakan')) return;
            if (!isMutasiRow && nama === 'Persediaan Pakan' && Number(d.kredit) > 0 && Number(d.debit) === 0) {
                let relTokens = String(d.relasi || '').split(',').map(s => s.trim()).filter(Boolean);
                let allKandangRel = relTokens.length > 0 && relTokens.every(tok => isKelompokTernakRelasi(tok) || tok.toLowerCase().startsWith('kandang'));
                let matchedDailyPemakaian = descL.includes('pemakaian') && removedPemakaianKeys.has(`${d.tanggal}|${Number(d.kredit)}`);
                if (allKandangRel || matchedDailyPemakaian) return;
            }

            // Sisipkan rincian bahan baku + HPP pada baris Konversi Bahan Baku Gilingan (Hasil Giling tetap total ringkas)
            if (nama === 'Persediaan Pakan' && Number(d.kredit) > 0 && descL.includes('konversi bahan baku gilingan')) {
                let rincianBahan = formatRincianBahanGiling(d.tanggal, descL);
                if (rincianBahan && !desc.includes('Bahan Baku:')) {
                    d.deskripsi = `${desc} [Bahan Baku: ${rincianBahan}]`;
                }
            }

            // Konversi hasil giling SPN (RL / RD) hanya jika view_jurnal_umum belum menanganinya secara native
            if (!sqlSudahHandleGiling && !String(d.id_jurnal || '').startsWith('TP-GIL-') && !descL.includes('upah giling') && relU === 'SPN' && (descL.includes('ransum laktasi') || descL.includes('ransum darbun'))) {
                let qtyMatch = desc.match(/(\d+(?:\.\d+)?)\s*Kg/i);
                let qtyG = qtyMatch ? Number(qtyMatch[1]) : 0;
                let upahG = Math.round(qtyG * 100);

                if (nama === 'Persediaan Pakan' && Number(d.debit) > 0 && upahG > 0) {
                    let rawHpp = Number(d.debit);
                    let effTotal = rawHpp + upahG;
                    let effUnit = qtyG > 0 ? Math.round(effTotal / qtyG) : 0;
                    d.debit = effTotal;
                    d.deskripsi = `${desc.replace(/\s*x\s*@[\d.,]+/i, '')} x @${nfLocal.format(effUnit)} (Bahan Baku Rp ${nfLocal.format(rawHpp)} + Upah Giling @100)`;
                    cleanedData.push(d);
                    return;
                }
                if (nama === 'Hutang Pakan' && Number(d.kredit) > 0) {
                    let rincianBahan = formatRincianBahanGiling(d.tanggal, descL);
                    cleanedData.push({
                        ...d,
                        kode_akun: '103',
                        nama_akun: 'Persediaan Pakan',
                        deskripsi: `Konversi Bahan Baku Gilingan (${desc})${rincianBahan ? ` [Bahan Baku: ${rincianBahan}]` : ''}`
                    });
                    if (upahG > 0) {
                        cleanedData.push({
                            id_jurnal: `${d.id_jurnal || 'GIL'}-UPAH`,
                            tanggal: d.tanggal,
                            kode_akun: '202',
                            nama_akun: 'Hutang Upah Giling',
                            relasi: 'OPR Giling SPN',
                            deskripsi: `Akrual Upah Giling ${qtyG} Kg x @100`,
                            debit: 0,
                            kredit: upahG
                        });
                    }
                    return;
                }
            }

            // Reklasifikasi pembayaran cashflow "Upah Giling" menjadi Debit Hutang Upah Giling (idempoten dengan SQL baru)
            if (d.id_jurnal && String(d.id_jurnal).startsWith('CF-') && Number(d.debit) > 0 && nama !== 'Kas' && nama !== 'Hutang Upah Giling') {
                let txtCheck = `${nama} ${desc}`.toLowerCase();
                if (txtCheck.includes('upah giling') || txtCheck.includes('opr giling') || nama.toLowerCase() === 'giling' || nama.toLowerCase() === 'biaya giling') {
                    d.kode_akun = '202';
                    d.nama_akun = 'Hutang Upah Giling';
                }
            }

            cleanedData.push(d);
        });
        data = cleanedData;

        // 2C. Sisipkan Rekap Pemakaian Kandang Akhir Bulan (1 baris per cabang, per kelompok sapi, per beda HPP di baris yang sama)
        Object.values(monthlyKandangMap).forEach(grpBranch => {
            if (grpBranch.totalHpp <= 0) return;
            let tokens = [];
            let unitDescParts = [];
            Object.keys(grpBranch.units).sort().forEach(unitName => {
                let items = Object.values(grpBranch.units[unitName]);
                let itemStrs = items.map(it => {
                    let baseTxt = `${it.pakan} ${nfLocal.format(it.qty)} ${it.satuan} x @${nfLocal.format(it.unitHpp)}`;
                    if (it.isEstimasi) {
                        let tIdx = tokens.length;
                        tokens.push(`${baseTxt} [HPP ESTIMASI SEMENTARA]`);
                        return `(%%EST_TOKEN_${tIdx}%%)`;
                    }
                    return `(${baseTxt})`;
                });
                unitDescParts.push(`${unitName} ${itemStrs.join(' + ')}`);
            });

            let cabangLabel = `Kandang ${grpBranch.cabangKey}`;
            let combinedDesc = `Rekap Pemakaian ${cabangLabel}: ${unitDescParts.join('; ')}`;

            data.push({
                id_jurnal: `REKAP-PMK-D-${grpBranch.monthEndDate}-${grpBranch.cabangKey}`,
                tanggal: grpBranch.monthEndDate,
                kode_akun: '505',
                nama_akun: 'Pemakaian Pakan Kandang',
                relasi: cabangLabel,
                deskripsi: combinedDesc,
                debit: grpBranch.totalHpp,
                kredit: 0,
                _estTokens: [...tokens],
                _isHppSementara: grpBranch.hasEstimasi,
                _hasInlineSementara: grpBranch.hasEstimasi
            });
            data.push({
                id_jurnal: `REKAP-PMK-K-${grpBranch.monthEndDate}-${grpBranch.cabangKey}`,
                tanggal: grpBranch.monthEndDate,
                kode_akun: '103',
                nama_akun: 'Persediaan Pakan',
                relasi: cabangLabel,
                deskripsi: `Persediaan Keluar ${cabangLabel}: ${unitDescParts.join('; ')}`,
                debit: 0,
                kredit: grpBranch.totalHpp,
                _estTokens: [...tokens],
                _isHppSementara: grpBranch.hasEstimasi,
                _hasInlineSementara: grpBranch.hasEstimasi
            });
        });

        // 3. Suntikkan HPP sementara penjualan komersial langsung ke baris kelompok HPP / Persediaan tanggal tsb
        let unmatchedGrouped = {};

        zeroHppTrxList.forEach(z => {
            // Cross-check jurnal: jika relasi ada di Pendapatan Penjualan / Piutang Pakan / HPP pada tanggal tsb -> PASTI Penjualan Komersial
            let adaDiPenjualanKomersial = data.some(d =>
                d.tanggal === z.tanggal &&
                relasiIncludes(d.relasi, z.relasi) &&
                ['Pendapatan Penjualan', 'Piutang Pakan', 'Harga Pokok Penjualan (HPP)'].includes((d.nama_akun || '').trim())
            );
            let isInternal = adaDiPenjualanKomersial ? false : z._isInternalKandang;

            let findPairForDate = (requireRelasiMatch) => {
                let dRow = data.find(d => {
                    if (d.tanggal !== z.tanggal) return false;
                    if (requireRelasiMatch && !relasiIncludes(d.relasi, z.relasi)) return false;
                    let nama = (d.nama_akun || '').trim();
                    if (isInternal) return nama.toLowerCase().includes('pemakaian pakan');
                    return nama === 'Harga Pokok Penjualan (HPP)' && Number(d.kredit) === 0;
                });
                let kRow = data.find(d => {
                    if (d.tanggal !== z.tanggal) return false;
                    if (requireRelasiMatch && !relasiIncludes(d.relasi, z.relasi)) return false;
                    let nama = (d.nama_akun || '').trim();
                    let descLower = (d.deskripsi || '').toLowerCase();
                    if (nama !== 'Persediaan Pakan') return false;
                    if (Number(d.debit) > 0 && !descLower.includes('keluar')) return false;
                    if (isInternal) return descLower.includes('pemakaian') || descLower.includes('persediaan keluar');
                    return descLower.includes('persediaan keluar') || (Number(d.kredit) > 0 && Number(d.debit) === 0 && !descLower.includes('pemakaian'));
                });
                return { dRow, kRow };
            };

            let { dRow: debitRow, kRow: kreditRow } = findPairForDate(true);
            // Jika penjualan komersial (misal semua barangnya HPP 0 shg namanya tertinggal dari baris rekap HPP), gabung ke baris rekap komersial tgl tsb
            if ((!debitRow || !kreditRow) && !isInternal) {
                let fallbackPair = findPairForDate(false);
                if (fallbackPair.dRow && fallbackPair.kRow) {
                    debitRow = fallbackPair.dRow;
                    kreditRow = fallbackPair.kRow;
                }
            }

            // BALANCE LOCK: Hanya suntikkan ke baris kelompok jika KEDUA sisi (Debit & Kredit) ditemukan berpasangan
            if (debitRow && kreditRow) {
                debitRow.relasi = appendRelasiToGroup(debitRow.relasi, z.relasi);
                debitRow.debit = (Number(debitRow.debit) || 0) + z._estTotalHpp;
                injectEstimasiIntoRow(debitRow, z);
                debitRow._isHppSementara = true;
                debitRow._hasInlineSementara = true;

                kreditRow.relasi = appendRelasiToGroup(kreditRow.relasi, z.relasi);
                kreditRow.kredit = (Number(kreditRow.kredit) || 0) + z._estTotalHpp;
                injectEstimasiIntoRow(kreditRow, z);
                kreditRow._isHppSementara = true;
                kreditRow._hasInlineSementara = true;
            } else {
                // Hanya jika di tanggal tsb belum ada sama sekali pasangan kelompok HPP/Pemakaian, kelompokkan per tanggal secara seimbang
                let gKey = `${z.tanggal}|${isInternal ? 'PEMAKAIAN' : 'HPP'}`;
                if (!unmatchedGrouped[gKey]) {
                    unmatchedGrouped[gKey] = {
                        tanggal: z.tanggal,
                        isInternal: isInternal,
                        relasiList: [],
                        itemsDesc: [],
                        tokens: [],
                        totalEst: 0
                    };
                }
                let grp = unmatchedGrouped[gKey];
                if (z.relasi && !grp.relasiList.includes(z.relasi)) grp.relasiList.push(z.relasi);
                let tokIdx = grp.tokens.length;
                grp.tokens.push(`${z.pakan} ${z.qty} ${z.satuan || 'Kg'} x @${z._estUnitHpp} [HPP ESTIMASI SEMENTARA]`);
                grp.itemsDesc.push(`${z.relasi} (%%EST_TOKEN_${tokIdx}%%)`);
                grp.totalEst += z._estTotalHpp;
            }
        });

        Object.values(unmatchedGrouped).forEach(grp => {
            let relJoin = grp.relasiList.join(', ');
            let descJoin = grp.itemsDesc.join('; ');
            data.push({
                id_jurnal: `EST-${grp.isInternal ? 'PMK' : 'HPP'}-D-${grp.tanggal}`,
                tanggal: grp.tanggal,
                kode_akun: grp.isInternal ? '505' : '402',
                nama_akun: grp.isInternal ? 'Pemakaian Pakan Kandang' : 'Harga Pokok Penjualan (HPP)',
                relasi: relJoin,
                deskripsi: `${grp.isInternal ? 'Pemakaian' : 'HPP'} ${descJoin}`,
                debit: grp.totalEst,
                kredit: 0,
                _estTokens: [...grp.tokens],
                _isHppSementara: true,
                _hasInlineSementara: true
            });
            data.push({
                id_jurnal: `EST-${grp.isInternal ? 'PMK' : 'HPP'}-K-${grp.tanggal}`,
                tanggal: grp.tanggal,
                kode_akun: '103',
                nama_akun: 'Persediaan Pakan',
                relasi: relJoin,
                deskripsi: `Persediaan Keluar ${descJoin}`,
                debit: 0,
                kredit: grp.totalEst,
                _estTokens: [...grp.tokens],
                _isHppSementara: true,
                _hasInlineSementara: true
            });
        });

        data.sort((a, b) => (a.tanggal || '').localeCompare(b.tanggal || '') || String(a.id_jurnal || '').localeCompare(String(b.id_jurnal || '')));

        jurnalDataGlobal = data;
        if (!silent && ssFilterState && ssFilterState.jurnal) {
            ssFilterState.jurnal = { kode: null, perkiraan: null, relasi: null };
            ['kode', 'perkiraan', 'relasi'].forEach(f => updateHeaderFilterIcons('jurnal', f));
        }
        renderJurnal(data);
    } catch (e) {
        console.error("Network error jurnal", e);
    } finally {
        if (!silent) document.getElementById('jurnal-loader').classList.add('hidden');
    }
}

function getJurnalRelasiTokens(relasiStr) {
    let raw = String(relasiStr || '').trim();
    if (!raw) return ['__EMPTY__'];
    let parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : ['__EMPTY__'];
}

function getFilteredJurnalRows(data) {
    let rows = Array.isArray(data) ? data : [];
    let jf = (typeof ssFilterState !== 'undefined' && ssFilterState.jurnal) ? ssFilterState.jurnal : {};
    let fKode = jf.kode;
    let fPerkiraan = jf.perkiraan;
    let fRelasi = jf.relasi;

    if (!fKode && !fPerkiraan && !fRelasi) return rows;

    return rows.filter(d => {
        let kodeDepan = d.kode_akun ? String(d.kode_akun).charAt(0) : '-';
        let matchKode = !fKode || fKode.has(kodeDepan);

        let namaAkun = (d.nama_akun || '').trim() || '-';
        let matchPerkiraan = !fPerkiraan || fPerkiraan.has(namaAkun);

        let matchRelasi = true;
        if (fRelasi) {
            let tokens = getJurnalRelasiTokens(d.relasi);
            matchRelasi = tokens.some(tok => fRelasi.has(tok));
        }
        return matchKode && matchPerkiraan && matchRelasi;
    });
}

function renderJurnal(data) {
    let tbody = document.getElementById('tbody-jurnal');
    let tDebit = 0;
    let tKredit = 0;
    let hasSementara = false;
    
    let html = "";
    let filtered = getFilteredJurnalRows(data);
    
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:#888;">Tidak ada transaksi jurnal pada rentang ini.</td></tr>`;
        document.getElementById('jurnal-total-debit').innerText = "0";
        document.getElementById('jurnal-total-kredit').innerText = "0";
        document.getElementById('jurnal-total-saldo').innerText = "0";
        document.getElementById('jurnal-hpp-legend')?.classList.add('hidden');
        return;
    }

    let nf = new Intl.NumberFormat('id-ID');
    let runningSaldo = 0;
    
    // Tarik data piutang lokal untuk lookup detail potongan nota
    let dataPiutangCache = localStorage.getItem('piutang_ptcbl_cache');
    let piutangParsed = (typeof dataPiutangLokal !== 'undefined' && dataPiutangLokal && Object.keys(dataPiutangLokal).length > 0)
        ? dataPiutangLokal
        : (dataPiutangCache ? JSON.parse(dataPiutangCache) : null);
    
    filtered.forEach((d, index) => {
        let tglStr = d.tanggal.split('-').reverse().join('/');
        let tglUraian = Number(d.tanggal.split('-')[2]) + '/' + Number(d.tanggal.split('-')[1]);
        
        // Ambil digit pertama dari kode akun
        let kodeDepan = d.kode_akun ? d.kode_akun.charAt(0) : "-";
        
        // Format angka (kosong jika 0)
        let debNum = Number(d.debit) || 0;
        let kreNum = Number(d.kredit) || 0;
        
        let debStr = debNum > 0 ? nf.format(debNum) : "";
        let kreStr = kreNum > 0 ? nf.format(kreNum) : "";
        
        // Hitung Saldo Berjalan
        runningSaldo += (debNum - kreNum);
        let saldoStr = runningSaldo === 0 ? "0" : nf.format(runningSaldo);
        
        // Format nominal mentah di dalam deskripsi (pembulatan desimal & pemisah ribuan)
        let deskripsiFormat = formatDeskripsiNominal(d.deskripsi, nf);
        if (d._estTokens && d._estTokens.length > 0) {
            d._estTokens.forEach((tokStr, tIdx) => {
                let tokFormatted = formatDeskripsiNominal(tokStr, nf);
                deskripsiFormat = deskripsiFormat.replace(
                    `%%EST_TOKEN_${tIdx}%%`,
                    `<span style="color:#2563eb; font-weight:600;">${tokFormatted}</span>`
                );
            });
        }

        // Gabungkan Uraian Dasar
        let uraian = `${d.nama_akun}. ${tglUraian} ${d.relasi ? d.relasi + ' ' : ''}${deskripsiFormat}`;
        
        // 🔥 INJEKSI DETAIL NOTA PIUTANG JIKA INI ADALAH PEMBAYARAN KAS (dan belum ada di uraian_fifo DB)
        let riwayatList = piutangParsed && d.relasi && piutangParsed[d.relasi]
            ? (piutangParsed[d.relasi].riwayat_all || piutangParsed[d.relasi].riwayat)
            : null;
        if (d.id_jurnal && d.id_jurnal.startsWith('CF-') && riwayatList && !uraian.includes('[Memotong:')) {
            let nominalCari = debNum > 0 ? debNum : kreNum;
            let matchedBayar = riwayatList.find(b => b.tgl === d.tanggal && b.nominal === nominalCari && !b._jurnal_used);
            
            if (matchedBayar && matchedBayar.detailPotongan && matchedBayar.detailPotongan.length > 0) {
                matchedBayar._jurnal_used = true;
                let teksPotong = formatDetailPotonganNota(matchedBayar.detailPotongan, nf, jurnalNotaItemsGlobal, d.relasi);
                uraian += ` [Memotong: ${teksPotong}]`;
            }
        }

        let isSementara = Boolean(d._isHppSementara);
        if (isSementara) {
            hasSementara = true;
            if (!d._hasInlineSementara) {
                uraian += ` <span style="color:#2563eb; font-weight:bold; font-size:10px;">[HPP ESTIMASI SEMENTARA]</span>`;
            }
        }
        
        let bg = index % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";
        let numStyle = isSementara ? "color:#2563eb; font-weight:bold;" : "";
        
        html += `<tr style="${bg}">
            <td style="padding:10px;">${tglStr}</td>
            <td style="padding:10px; text-align:center;">${kodeDepan}</td>
            <td style="padding:10px;">${d.nama_akun}</td>
            <td style="padding:10px;">${d.relasi || ''}</td>
            <td style="padding:10px; line-height:1.4;">${uraian}</td>
            <td style="padding:10px; text-align:right; ${numStyle}" title="${isSementara ? 'HPP Sementara (Estimasi) - Menunggu input HPP' : ''}">${debStr}</td>
            <td style="padding:10px; text-align:right; ${numStyle}" title="${isSementara ? 'HPP Sementara (Estimasi) - Menunggu input HPP' : ''}">${kreStr}</td>
            <td style="padding:10px; text-align:right; font-weight:bold;">${saldoStr}</td>
        </tr>`;
        
        tDebit += debNum;
        tKredit += kreNum;
    });

    tbody.innerHTML = html;
    document.getElementById('jurnal-total-debit').innerText = nf.format(tDebit);
    document.getElementById('jurnal-total-kredit').innerText = nf.format(tKredit);
    document.getElementById('jurnal-total-saldo').innerText = nf.format(tDebit - tKredit);
    let legendEl = document.getElementById('jurnal-hpp-legend');
    if (legendEl) {
        if (hasSementara) legendEl.classList.remove('hidden');
        else legendEl.classList.add('hidden');
    }
    
    // Peringatan jika tidak balance
    if (tDebit !== tKredit) {
        document.getElementById('jurnal-total-debit').style.color = "#c62828";
        document.getElementById('jurnal-total-kredit').style.color = "#c62828";
    } else {
        document.getElementById('jurnal-total-debit').style.color = "#2e7d32";
        document.getElementById('jurnal-total-kredit').style.color = "#2e7d32";
    }
}

// Inisialisasi Tanggal Saat Buka Menu Jurnal
function initTanggalJurnal() {
    if (!document.getElementById('jurnal-bulan').value || document.getElementById('jurnal-bulan').value === 'ALL') {
        let now = new Date();
        document.getElementById('jurnal-bulan').value = ("0" + (now.getMonth() + 1)).slice(-2);
        document.getElementById('jurnal-tahun').value = now.getFullYear();
    }
}

function exportExcelJurnal(targetFormat = 'xlsx') {
    if (!jurnalDataGlobal || jurnalDataGlobal.length === 0) {
        alert("Tidak ada data untuk diexport!");
        return;
    }

    // Ambil data yang terfilter saat ini (sama persis dengan yang tampil di tabel)
    let filtered = getFilteredJurnalRows(jurnalDataGlobal);

    if (filtered.length === 0) {
        alert("Tidak ada data yang sesuai filter untuk diexport!");
        return;
    }

    let nf = new Intl.NumberFormat('id-ID');
    let runningSaldo = 0;

    // Tarik data piutang untuk memo potong nota jika ada
    let dataPiutangCache = localStorage.getItem('piutang_ptcbl_cache');
    let piutangParsed = (typeof dataPiutangLokal !== 'undefined' && dataPiutangLokal && Object.keys(dataPiutangLokal).length > 0)
        ? dataPiutangLokal
        : (dataPiutangCache ? JSON.parse(dataPiutangCache) : null);

    // Deep clone data potongan nota agar flag tidak merusak tampilan tabel
    let cloneRiwayat = {};
    if (piutangParsed) {
        Object.keys(piutangParsed).forEach(rel => {
            let srcList = piutangParsed[rel] && (piutangParsed[rel].riwayat_all || piutangParsed[rel].riwayat);
            if (srcList) {
                cloneRiwayat[rel] = srcList.map(b => ({ ...b, _exp_used: false }));
            }
        });
    }

    let exportRows = [];
    let bulanStr = document.getElementById('jurnal-bulan')?.value || 'Semua';
    let tahunStr = document.getElementById('jurnal-tahun')?.value || new Date().getFullYear();

    filtered.forEach(d => {
        let tglStr = d.tanggal.split('-').reverse().join('/');
        let tglUraian = Number(d.tanggal.split('-')[2]) + '/' + Number(d.tanggal.split('-')[1]);
        let kodeDepan = d.kode_akun ? d.kode_akun.charAt(0) : "-";
        let debNum = Number(d.debit) || 0;
        let kreNum = Number(d.kredit) || 0;

        runningSaldo += (debNum - kreNum);

        let deskripsiFormat = formatDeskripsiNominal(d.deskripsi, nf);
        if (d._estTokens && d._estTokens.length > 0) {
            d._estTokens.forEach((tokStr, tIdx) => {
                let tokFormatted = formatDeskripsiNominal(tokStr, nf);
                deskripsiFormat = deskripsiFormat.replace(`%%EST_TOKEN_${tIdx}%%`, tokFormatted);
            });
        }

        let uraian = `${d.nama_akun}. ${tglUraian} ${d.relasi ? d.relasi + ' ' : ''}${deskripsiFormat}`;

        if (d.id_jurnal && d.id_jurnal.startsWith('CF-') && cloneRiwayat[d.relasi] && !uraian.includes('[Memotong:')) {
            let nominalCari = debNum > 0 ? debNum : kreNum;
            let matchedBayar = cloneRiwayat[d.relasi].find(b => b.tgl === d.tanggal && b.nominal === nominalCari && !b._exp_used);
            if (matchedBayar && matchedBayar.detailPotongan && matchedBayar.detailPotongan.length > 0) {
                matchedBayar._exp_used = true;
                let teksPotong = formatDetailPotonganNota(matchedBayar.detailPotongan, nf, jurnalNotaItemsGlobal, d.relasi);
                uraian += ` [Memotong: ${teksPotong}]`;
            }
        }
        if (d._isHppSementara && !d._hasInlineSementara) {
            uraian += ` [HPP ESTIMASI SEMENTARA]`;
        }

        exportRows.push({
            'Tanggal': tglStr,
            'KODE': kodeDepan,
            'Perkiraan': d.nama_akun,
            'Relasi': d.relasi || '',
            'Uraian': uraian,
            'Debit': debNum,
            'Kredit': kreNum,
            'Saldo': runningSaldo
        });
    });

    let filename = `Jurnal_Umum_${bulanStr}_${tahunStr}`;

    // Eksekusi ekspor berdasarkan pilihan format (CSV atau XLSX)
    if (targetFormat === 'csv' || typeof XLSX === 'undefined') {
        // Export CSV UTF-8 dengan BOM (Bisa dibuka langsung di Excel & Sheets dengan pemisah semicolon)
        let csvHeader = ["Tanggal", "KODE", "Perkiraan", "Relasi", "Uraian", "Debit", "Kredit", "Saldo"];
        let csvRows = [csvHeader.join(";")];

        exportRows.forEach(r => {
            let row = [
                `"${r['Tanggal']}"`,
                `"${r['KODE']}"`,
                `"${(r['Perkiraan'] || '').replace(/"/g, '""')}"`,
                `"${(r['Relasi'] || '').replace(/"/g, '""')}"`,
                `"${(r['Uraian'] || '').replace(/"/g, '""')}"`,
                r['Debit'],
                r['Kredit'],
                r['Saldo']
            ];
            csvRows.push(row.join(";"));
        });

        let csvString = "\uFEFFsep=;\r\n" + csvRows.join("\r\n");
        let blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        let link = document.createElement("a");
        let url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `${filename}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } else {
        // Export file .XLSX Excel Asli via SheetJS
        let wb = XLSX.utils.book_new();
        let ws = XLSX.utils.json_to_sheet(exportRows);

        // Atur lebar kolom agar proporsional dan rapi
        ws['!cols'] = [
            { wch: 12 }, // Tanggal
            { wch: 8 },  // KODE
            { wch: 25 }, // Perkiraan
            { wch: 22 }, // Relasi
            { wch: 60 }, // Uraian
            { wch: 16 }, // Debit
            { wch: 16 }, // Kredit
            { wch: 18 }  // Saldo
        ];

        XLSX.utils.book_append_sheet(wb, ws, "Jurnal Umum");
        XLSX.writeFile(wb, `${filename}.xlsx`);
    }
}

// Helper Dropdown Pilihan Format Download
function toggleDropdownExportJurnal(event) {
    if (event) event.stopPropagation();
    let dd = document.getElementById('dropdown-export-jurnal');
    if (dd) {
        dd.classList.toggle('hidden');
    }
}

function exportJurnalDenganFormat(fmt) {
    let dd = document.getElementById('dropdown-export-jurnal');
    if (dd) dd.classList.add('hidden');
    exportExcelJurnal(fmt);
}

// Event listener global untuk menutup dropdown jika klik di luar
document.addEventListener('click', (e) => {
    let dd = document.getElementById('dropdown-export-jurnal');
    let btn = document.getElementById('btn-jurnal-download');
    if (dd && !dd.classList.contains('hidden') && btn && !btn.contains(e.target) && !dd.contains(e.target)) {
        dd.classList.add('hidden');
    }
});

// ==========================================
// SUB-MENU: KARTU PIUTANG KONSUMEN
// ==========================================

const ALL_JURNAL_TABS = ['data-mentah', 'tracking-hpp', 'umum', 'kartu-piutang', 'laba-rugi', 'neraca'];

function switchTabJurnal(activeTab) {
    ALL_JURNAL_TABS.forEach(t => {
        let btn = document.getElementById(`tab-jurnal-${t}`);
        let view = document.getElementById(`view-jurnal-${t}`);
        if (t === activeTab) {
            btn?.classList.add('active');
            view?.classList.remove('hidden');
        } else {
            btn?.classList.remove('active');
            view?.classList.add('hidden');
        }
    });

    if (activeTab === 'kartu-piutang') {
        let inp = document.getElementById('kp-filter-konsumen');
        if (inp && !inp.value.trim()) {
            setTimeout(() => inp.focus(), 150);
        }
    } else if (activeTab === 'data-mentah') {
        initTanggalMentah();
        if (!dataMentahGlobal || dataMentahGlobal.length === 0) {
            fetchDataMentah();
        }
    } else if (activeTab === 'tracking-hpp') {
        initTanggalHPP();
        if (!hppOutflowGlobal || hppOutflowGlobal.length === 0) {
            fetchTrackingHPP();
        }
    } else if (activeTab === 'laba-rugi') {
        initTanggalLR();
        muatLabaRugi();
    } else if (activeTab === 'neraca') {
        initTanggalNeraca();
        muatNeraca();
    }
}

function escapeHtmlKP(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function muatKartuPiutang() {
    let inputEl = document.getElementById('kp-filter-konsumen');
    let namaKonsumen = inputEl ? inputEl.value.trim() : '';
    let periode = document.getElementById('kp-filter-periode') ? document.getElementById('kp-filter-periode').value : 'ALL';

    if (!namaKonsumen) {
        alert("Silakan masukkan atau pilih nama konsumen / peternak terlebih dahulu!");
        inputEl?.focus();
        return;
    }

    let loader = document.getElementById('kp-loader');
    let summaryCard = document.getElementById('kp-summary-card');
    let tableContainer = document.getElementById('kp-table-container');
    let emptyState = document.getElementById('kp-empty-state');

    loader?.classList.remove('hidden');
    summaryCard?.classList.add('hidden');
    tableContainer?.classList.add('hidden');
    emptyState?.classList.add('hidden');

    try {
        let fnFetch = (typeof fetchSupabaseAll === 'function') ? fetchSupabaseAll : (typeof window !== 'undefined' && typeof window.fetchSupabaseAll === 'function' ? window.fetchSupabaseAll : null);
        let urlTarget = `${SUPA_URL}/rest/v1/view_mutasi_piutang_detail?relasi=eq.${encodeURIComponent(namaKonsumen)}&order=tanggal.asc,id_sumber.asc`;
        
        let data = [];
        if (fnFetch) {
            data = await fnFetch(urlTarget);
        } else {
            let res = await fetch(urlTarget, {
                headers: {
                    'apikey': SUPA_ANON_KEY,
                    'Authorization': `Bearer ${SUPA_ANON_KEY}`
                }
            });
            if (res.ok) data = await res.json();
            else throw new Error(await res.text());
        }

        if (!data || data.length === 0) {
            loader?.classList.add('hidden');
            emptyState?.classList.remove('hidden');
            emptyState.innerHTML = `
                <span class="material-symbols-outlined" style="font-size:48px; color:#cbd5e1; display:block; margin-bottom:10px;">search_off</span>
                <div style="font-size:14px; font-weight:bold; color:#475569;">Tidak Ditemukan Riwayat</div>
                <div style="font-size:12px; color:#64748b; margin-top:4px;">Tidak ada riwayat mutasi piutang untuk konsumen "<strong>${escapeHtmlKP(namaKonsumen)}</strong>". Pastikan nama sesuai dengan data peternak.</div>
            `;
            return;
        }

        prosesDanRenderKartuPiutang(data, namaKonsumen, periode);
    } catch (e) {
        console.error("Gagal muat kartu piutang", e);
        loader?.classList.add('hidden');
        emptyState?.classList.remove('hidden');
        emptyState.innerHTML = `
            <span class="material-symbols-outlined" style="font-size:48px; color:#ef4444; display:block; margin-bottom:10px;">error</span>
            <div style="font-size:14px; font-weight:bold; color:#b91c1c;">Gagal Memuat Data</div>
            <div style="font-size:12px; color:#64748b; margin-top:4px;">Terjadi kesalahan saat mengambil data mutasi piutang. Silakan coba kembali.</div>
        `;
    } finally {
        loader?.classList.add('hidden');
    }
}

// ==========================================
// PUSAT KALKULASI KARTU PIUTANG (SHARED ENGINE)
// ==========================================
function hitungKartuPiutang(data, namaKonsumen, periode) {
    let nf = new Intl.NumberFormat('id-ID');

    // 1. Pilah Tagihan & Pembayaran
    let tagihanArr = [];
    let bayarArr = [];

    data.forEach(row => {
        let namaPkn = row.pakan_kategori || 'Pakan';
        let jenisMutasi = String(row.jenis_mutasi || '').toLowerCase();
        let nominal = parseFloat(row.nominal) || parseFloat(row.tagihan) || parseFloat(row.pembayaran) || 0;
        let qtyFisik = parseFloat(row.qty) || 0;
        let isBayar = jenisMutasi === 'pembayaran' || namaPkn.toLowerCase().includes('bayar');

        if (isBayar) {
            bayarArr.push({
                id: row.id_sumber,
                tgl: row.tanggal,
                nominal: Math.abs(nominal),
                sisaBayar: Math.abs(nominal),
                metode: row.metode || 'Cash',
                bukti_url: (row.bukti_url && row.bukti_url !== '-' && row.bukti_url !== 'null') ? row.bukti_url : null,
                keterangan: row.keterangan || '',
                detailPotongan: [],
                raw: row
            });
        } else {
            let isOngkir = namaPkn.toLowerCase().includes('ongkir');
            let isTarikDeposit = namaPkn.toLowerCase().includes('tarik deposit') || jenisMutasi.includes('tarik deposit');
            let hargaSatuan = parseFloat(row.harga_satuan) || 0;
            if (!hargaSatuan && qtyFisik > 0) hargaSatuan = Math.abs(nominal) / qtyFisik;

            tagihanArr.push({
                id: row.id_sumber,
                tgl: row.tanggal,
                pakan: isTarikDeposit ? 'Tarik Deposit / Penyesuaian Kas' : (isOngkir ? 'Ongkir Pengiriman' : namaPkn),
                isOngkir: isOngkir,
                isTarikDeposit: isTarikDeposit,
                qty: qtyFisik,
                satuan: isOngkir ? 'Rit' : (row.satuan || 'Kg'),
                harga_satuan: hargaSatuan,
                nominal: Math.abs(nominal),
                raw: row
            });
        }
    });

    // 2. Kelompokkan Tagihan berdasarkan Tanggal Nota
    let groupedNota = {};
    tagihanArr.forEach(item => {
        if (!groupedNota[item.tgl]) {
            groupedNota[item.tgl] = { tgl: item.tgl, totalTagihan: 0, terbayar: 0, items: [] };
        }
        groupedNota[item.tgl].totalTagihan += item.nominal;
        groupedNota[item.tgl].items.push(item);
    });
    let arrNota = Object.values(groupedNota).sort((a, b) => new Date(a.tgl) - new Date(b.tgl));

    // 3. FIFO Matching
    // FASE 1: Exact Match Tunai Langsung
    bayarArr.forEach(uang => {
        let isTunaiLangsung = String(uang.raw?.pakan_kategori || '').toLowerCase().includes('bayar tunai');
        if (isTunaiLangsung && uang.sisaBayar > 0) {
            let matched = arrNota.find(n => n.tgl === uang.tgl && n.totalTagihan > 0 && n.terbayar === 0 && !n.isExactMatched);
            if (matched) {
                let dipotong = Math.min(matched.totalTagihan, uang.sisaBayar);
                uang.detailPotongan.push({ tglNota: matched.tgl, jumlah: dipotong, isTunai: true, items: matched.items });
                matched.terbayar += dipotong;
                uang.sisaBayar -= dipotong;
                if (matched.terbayar >= matched.totalTagihan) matched.isExactMatched = true;
            }
        }
    });

    // FASE 1.1: Prioritas Diskon Tanggal Sama (Same-Day Discount Matching)
    bayarArr.forEach(uang => {
        let isDiskon = parseFloat(uang.raw?.diskon || 0) > 0 || String(uang.raw?.keterangan || '').toLowerCase().includes('diskon');
        if (isDiskon && uang.sisaBayar > 0) {
            let matched = arrNota.find(n => n.tgl === uang.tgl && (n.totalTagihan - n.terbayar) > 0);
            if (matched) {
                let sisaNota = matched.totalTagihan - matched.terbayar;
                let dipotong = Math.min(sisaNota, uang.sisaBayar);
                uang.detailPotongan.push({ tglNota: matched.tgl, jumlah: dipotong, isDiskon: true, items: matched.items });
                matched.terbayar += dipotong;
                uang.sisaBayar -= dipotong;
                if (matched.terbayar >= matched.totalTagihan) matched.isExactMatched = true;
            }
        }
    });

    // FASE 2: Sequential FIFO (Aturan: Tanggal uang masuk tidak bisa melebihi tanggal tagihan)
    for (let i = 0; i < bayarArr.length; i++) {
        let uang = bayarArr[i];
        if (uang.sisaBayar <= 0) continue;

        for (let j = 0; j < arrNota.length; j++) {
            let nota = arrNota[j];
            if (nota.tgl > uang.tgl) break;

            let sisaNota = nota.totalTagihan - nota.terbayar;
            if (sisaNota <= 0) continue;

            let dipotong = Math.min(sisaNota, uang.sisaBayar);
            uang.detailPotongan.push({ tglNota: nota.tgl, jumlah: dipotong, items: nota.items });
            nota.terbayar += dipotong;
            uang.sisaBayar -= dipotong;

            if (uang.sisaBayar <= 0) break;
        }
    }

    // 4. Hitung Saldo Keseluruhan Konsumen
    let grandTagihan = tagihanArr.reduce((s, t) => s + t.nominal, 0);
    let grandBayar = bayarArr.reduce((s, b) => s + b.nominal, 0);
    let grandSisaSaldo = grandTagihan - grandBayar;

    // Klasifikasi Sehat vs Telat (15 hari)
    let hariIni = new Date();
    hariIni.setHours(0, 0, 0, 0);
    let piutangSehat = 0;
    let piutangTelat = 0;

    arrNota.forEach(nota => {
        let sisaNyata = nota.totalTagihan - nota.terbayar;
        if (sisaNyata > 0) {
            let dTrx = new Date(nota.tgl);
            dTrx.setHours(0, 0, 0, 0);
            let jtDate = new Date(dTrx);
            jtDate.setDate(jtDate.getDate() + 15);
            if (jtDate < hariIni) {
                piutangTelat += sisaNyata;
            } else {
                piutangSehat += sisaNyata;
            }
        }
    });

    let totalHutangAktif = piutangSehat + piutangTelat;
    let basePiutang = totalHutangAktif > 0 ? totalHutangAktif : 1;
    let pctSehat = Math.round((piutangSehat / basePiutang) * 100);
    let pctTelat = Math.round((piutangTelat / basePiutang) * 100);

    let relasiList = (typeof globalRelasi !== 'undefined' && Array.isArray(globalRelasi)) ? globalRelasi : [];
    let relasiObj = relasiList.find(r => r.nama && r.nama.toLowerCase() === (namaKonsumen || '').toLowerCase());
    let alamat = (relasiObj && relasiObj.alamat) ? relasiObj.alamat : 'Alamat tidak terdata';
    let kategori = (relasiObj && relasiObj.kategori) ? relasiObj.kategori : 'Peternak';

    // 5. Timeline kronologis
    let timeline = [];
    let attachedPaymentIds = new Set();

    arrNota.forEach(nota => {
        let attached = bayarArr.filter(b => {
            if (!b.detailPotongan || b.detailPotongan.length === 0) return false;
            let lastCut = b.detailPotongan[b.detailPotongan.length - 1];
            return lastCut.tglNota === nota.tgl;
        });
        attached.forEach(b => attachedPaymentIds.add(b.id || (b.tgl + '_' + b.nominal)));
        timeline.push({
            date: nota.tgl,
            type: 'NOTA',
            nota: nota,
            attachedPayments: attached
        });
    });

    bayarArr.forEach(b => {
        let key = b.id || (b.tgl + '_' + b.nominal);
        if (!attachedPaymentIds.has(key)) {
            timeline.push({
                date: b.tgl,
                type: 'STANDALONE_PAYMENT',
                payment: b
            });
        }
    });

    timeline.sort((a, b) => {
        if (a.date !== b.date) return new Date(a.date) - new Date(b.date);
        if (a.type === 'NOTA' && b.type !== 'NOTA') return -1;
        if (a.type !== 'NOTA' && b.type === 'NOTA') return 1;
        return 0;
    });

    let allDatesSet = new Set();
    timeline.forEach(ev => {
        if (ev.type === 'NOTA') {
            if (periode === 'ALL' || ev.nota.tgl.startsWith(periode)) {
                allDatesSet.add(ev.nota.tgl);
            }
            if (ev.attachedPayments) {
                ev.attachedPayments.forEach(b => {
                    if (periode === 'ALL' || b.tgl.startsWith(periode)) {
                        allDatesSet.add(b.tgl);
                    }
                });
            }
        } else if (ev.type === 'STANDALONE_PAYMENT') {
            if (periode === 'ALL' || ev.payment.tgl.startsWith(periode)) {
                allDatesSet.add(ev.payment.tgl);
            }
        }
    });
    let allEventDates = Array.from(allDatesSet).sort();

    return {
        tagihanArr,
        bayarArr,
        arrNota,
        grandTagihan,
        grandBayar,
        grandSisaSaldo,
        piutangSehat,
        piutangTelat,
        pctSehat,
        pctTelat,
        alamat,
        kategori,
        timeline,
        allEventDates,
        namaKonsumen,
        periode
    };
}

// Format Tanggal Helper (YYYY-MM-DD -> DD/MM/YYYY)
function fmtTglKP(tglStr) {
    if (!tglStr) return '-';
    let parts = tglStr.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return tglStr;
}

// Helper State per Prefix ('kp' vs 'portal-kp')
function getKPState(prefix) {
    if (prefix === 'portal-kp') {
        return {
            getCached: () => window.portalKpCachedState,
            setCached: (val) => { window.portalKpCachedState = val; },
            getSelectedDates: () => window.portalKpSelectedDates,
            setSelectedDates: (val) => { window.portalKpSelectedDates = val; }
        };
    }
    return {
        getCached: () => window.kpCachedState,
        setCached: (val) => { window.kpCachedState = val; },
        getSelectedDates: () => window.kpSelectedDates,
        setSelectedDates: (val) => { window.kpSelectedDates = val; }
    };
}

// Update Label Tombol Filter Tanggal & Badge Counter
function updateMultiDateLabelGeneric(prefix, allDates) {
    let lbl = document.getElementById(`${prefix}-multidate-label`);
    let badge = document.getElementById(`${prefix}-multidate-count-badge`);
    let chkAll = document.getElementById(`${prefix}-multidate-checkall`);
    let state = getKPState(prefix);
    let selectedDates = state.getSelectedDates();
    if (!lbl || !badge || !selectedDates) return;

    let total = allDates ? allDates.length : 0;
    let selectedCount = selectedDates.size;

    badge.textContent = `${selectedCount} / ${total} Tgl`;

    if (chkAll) {
        chkAll.checked = (total > 0 && selectedCount === total);
        chkAll.indeterminate = (selectedCount > 0 && selectedCount < total);
    }

    if (total === 0) {
        lbl.textContent = "Tidak ada tanggal";
    } else if (selectedCount === total) {
        lbl.textContent = "Semua Tanggal";
    } else if (selectedCount === 0) {
        lbl.textContent = "0 Tanggal Dipilih";
    } else if (selectedCount === 1) {
        let onlyDate = Array.from(selectedDates)[0];
        lbl.textContent = fmtTglKP(onlyDate);
    } else if (selectedCount === 2) {
        let arr = Array.from(selectedDates).sort();
        lbl.textContent = `${fmtTglKP(arr[0])}, ${fmtTglKP(arr[1])}`;
    } else {
        lbl.textContent = `${selectedCount} Tanggal Terpilih`;
    }
}

// Render Dropdown Checkbox Daftar Tanggal
function populateMultiDateDropdownGeneric(prefix, allEventDates, timeline, periode) {
    let listContainer = document.getElementById(`${prefix}-multidate-list`);
    if (!listContainer) return;

    if (allEventDates.length === 0) {
        listContainer.innerHTML = `<div style="padding:15px; text-align:center; font-size:11px; color:#94a3b8; font-style:italic;">Tidak ada transaksi pada periode ini</div>`;
        updateMultiDateLabelGeneric(prefix, allEventDates);
        return;
    }

    let dateCounts = {};
    timeline.forEach(ev => {
        if (ev.type === 'NOTA') {
            if (periode === 'ALL' || ev.nota.tgl.startsWith(periode)) {
                let count = ev.nota.items ? ev.nota.items.length : 1;
                dateCounts[ev.nota.tgl] = (dateCounts[ev.nota.tgl] || 0) + count;
            }
            if (ev.attachedPayments) {
                ev.attachedPayments.forEach(b => {
                    if (periode === 'ALL' || b.tgl.startsWith(periode)) {
                        dateCounts[b.tgl] = (dateCounts[b.tgl] || 0) + 1;
                    }
                });
            }
        } else if (ev.type === 'STANDALONE_PAYMENT') {
            let b = ev.payment;
            if (periode === 'ALL' || b.tgl.startsWith(periode)) {
                dateCounts[b.tgl] = (dateCounts[b.tgl] || 0) + 1;
            }
        }
    });

    let state = getKPState(prefix);
    let selectedDates = state.getSelectedDates();
    let changeFn = (prefix === 'portal-kp') ? 'onDateCheckboxChangePortalKP()' : 'onDateCheckboxChangeKP()';

    let listHtml = allEventDates.map(tgl => {
        let isChecked = selectedDates ? selectedDates.has(tgl) : true;
        let count = dateCounts[tgl] || 1;
        return `
            <label style="display:flex; align-items:center; gap:8px; padding:7px 12px; font-size:12px; color:#334155; cursor:pointer; transition:background 0.15s; border-bottom:1px solid #f1f5f9; user-select:none;"
                   onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
                <input type="checkbox" class="${prefix}-date-checkbox" value="${tgl}" ${isChecked ? 'checked' : ''} onchange="${changeFn}" style="cursor:pointer; accent-color:#8AA624; width:15px; height:15px;">
                <span style="font-weight:600; color:#1e293b;">${fmtTglKP(tgl)}</span>
                <span style="font-size:10px; color:#64748b; margin-left:auto; background:#f1f5f9; padding:2px 7px; border-radius:4px; font-weight:500;">${count} trx</span>
            </label>
        `;
    }).join('');

    listContainer.innerHTML = listHtml;
    updateMultiDateLabelGeneric(prefix, allEventDates);
}

// Handler Saat Checkbox Tanggal Diubah
function onDateCheckboxChangeGeneric(prefix) {
    let checkboxes = document.querySelectorAll(`.${prefix}-date-checkbox`);
    let selected = new Set();
    checkboxes.forEach(cb => {
        if (cb.checked) selected.add(cb.value);
    });
    let state = getKPState(prefix);
    state.setSelectedDates(selected);

    let allDates = Array.from(checkboxes).map(cb => cb.value);
    updateMultiDateLabelGeneric(prefix, allDates);

    if (state.getCached()) {
        renderKartuPiutangTableGeneric(prefix);
    }
}

// Handler Pilih Semua / Hapus Pilihan
function toggleSelectAllDatesGeneric(prefix, checked) {
    let checkboxes = document.querySelectorAll(`.${prefix}-date-checkbox`);
    let selected = new Set();
    checkboxes.forEach(cb => {
        cb.checked = checked;
        if (checked) selected.add(cb.value);
    });
    let state = getKPState(prefix);
    state.setSelectedDates(selected);

    let allDates = Array.from(checkboxes).map(cb => cb.value);
    updateMultiDateLabelGeneric(prefix, allDates);

    if (state.getCached()) {
        renderKartuPiutangTableGeneric(prefix);
    }
}

// Toggle Dropdown Filter Tanggal
function toggleMultiDateDropdownGeneric(prefix, e) {
    if (e) e.stopPropagation();
    let dropdown = document.getElementById(`${prefix}-multidate-dropdown`);
    if (!dropdown) return;
    dropdown.classList.toggle('hidden');
}

// Handler Ganti Periode
function onPeriodChangeGeneric(prefix) {
    let state = getKPState(prefix);
    state.setSelectedDates(null);
    if (prefix === 'kp') {
        muatKartuPiutang();
    } else if (prefix === 'portal-kp') {
        let selPeriode = document.getElementById('portal-kp-filter-periode');
        let periode = selPeriode ? selPeriode.value : '2026';
        let nama = document.getElementById('analytics_relasi')?.value?.trim() || '';
        if (window.portalMutasiData) {
            prosesDanRenderKartuPiutangGeneric('portal-kp', window.portalMutasiData, nama, periode);
        }
    }
}

// ==========================================
// RENDER KARTU PIUTANG (GENERIC RENDERER)
// ==========================================
function prosesDanRenderKartuPiutangGeneric(prefix, data, namaKonsumen, periode) {
    let summaryCard = document.getElementById(`${prefix}-summary-card`);
    let nf = new Intl.NumberFormat('id-ID');

    // 1. Hitung data dengan calculation engine
    let calc = hitungKartuPiutang(data, namaKonsumen, periode);
    let {
        tagihanArr,
        bayarArr,
        arrNota,
        grandTagihan,
        grandBayar,
        grandSisaSaldo,
        piutangSehat,
        piutangTelat,
        pctSehat,
        pctTelat,
        alamat,
        kategori,
        timeline,
        allEventDates
    } = calc;

    // Status Badge
    let badgeHtml = '';
    if (grandSisaSaldo < 0) {
        badgeHtml = `<span style="font-size:10px; font-weight:700; padding:3px 9px; border-radius:20px; background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc;">DEPOSIT</span>`;
    } else if (grandSisaSaldo === 0 && tagihanArr.length > 0) {
        badgeHtml = `<span style="font-size:10px; font-weight:700; padding:3px 9px; border-radius:20px; background:#dcfce7; color:#15803d; border:1px solid #86efac;">LUNAS</span>`;
    }

    // Diagram Pembagian Piutang Sehat vs Terlambat
    let diagramHtml = '';
    if (grandSisaSaldo > 0) {
        diagramHtml = `
            <div style="background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; padding: 12px 14px; margin-top: 14px; width: 100%; box-sizing: border-box;">
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; margin-bottom:7px; color:#e2e8f0; font-weight:600;">
                    <span style="display:inline-flex; align-items:center; gap:5px;">
                        <span class="material-symbols-outlined" style="font-size:16px; color:#93c5fd;">pie_chart</span>
                        Status Pembagian Piutang (Jatuh Tempo 15 Hari)
                    </span>
                    <span style="font-size:10px; color:#cbd5e1;">Total Piutang: Rp ${nf.format(grandSisaSaldo)}</span>
                </div>
                
                <div style="height: 10px; border-radius: 5px; background: rgba(0, 0, 0, 0.35); overflow: hidden; display: flex; box-shadow: inset 0 1px 2px rgba(0,0,0,0.2);">
                    <div style="width: ${pctSehat}%; background-color: #FEA405; transition: width 0.4s ease;" title="Tagihan Berjalan (Sehat): Rp ${nf.format(piutangSehat)} (${pctSehat}%)"></div>
                    <div style="width: ${pctTelat}%; background-color: #ef4444; transition: width 0.4s ease;" title="Jatuh Tempo (Terlambat): Rp ${nf.format(piutangTelat)} (${pctTelat}%)"></div>
                </div>

                <div style="display: flex; justify-content: space-between; margin-top: 9px; gap: 15px; flex-wrap: wrap;">
                    <div style="flex: 1; min-width: 140px;">
                        <div style="font-size: 10px; color: #fde68a; font-weight: 700; text-transform: uppercase; display: flex; align-items: center; gap: 5px;">
                            <span style="width: 8px; height: 8px; border-radius: 50%; background: #FEA405; display: inline-block;"></span> TAGIHAN BERJALAN (SEHAT)
                        </div>
                        <div style="font-size: 14px; font-weight: 800; color: #ffffff; margin-top: 2px;">
                            Rp ${nf.format(piutangSehat)} <span style="font-size: 11px; font-weight: normal; opacity: 0.85;">(${pctSehat}%)</span>
                        </div>
                    </div>
                    <div style="flex: 1; min-width: 140px; text-align: right;">
                        <div style="font-size: 10px; color: #fca5a5; font-weight: 700; text-transform: uppercase; display: flex; align-items: center; justify-content: flex-end; gap: 5px;">
                            <span style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444; display: inline-block;"></span> JATUH TEMPO (TERLAMBAT)
                        </div>
                        <div style="font-size: 14px; font-weight: 800; color: #ffffff; margin-top: 2px;">
                            Rp ${nf.format(piutangTelat)} <span style="font-size: 11px; font-weight: normal; opacity: 0.85;">(${pctTelat}%)</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    if (summaryCard) {
        summaryCard.innerHTML = `
            <div style="background: #1e3a8a; border-radius: 12px; padding: 18px 20px; color: white; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.12); display: flex; flex-direction: column;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; width: 100%;">
                    <div style="flex: 1; min-width: 220px;">
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <span class="material-symbols-outlined" style="font-size:22px; color:#93c5fd;">person</span>
                            <span style="font-size:18px; font-weight:800; letter-spacing:0.3px;">${escapeHtmlKP(namaKonsumen)}</span>
                            ${badgeHtml}
                        </div>
                        <div style="font-size:11px; opacity:0.85; margin-top:6px; display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
                            <span style="display:inline-flex; align-items:center; gap:3px;"><span class="material-symbols-outlined" style="font-size:14px; color:#93c5fd;">location_on</span> ${escapeHtmlKP(alamat)}</span>
                            <span style="display:inline-flex; align-items:center; gap:3px;"><span class="material-symbols-outlined" style="font-size:14px; color:#93c5fd;">category</span> ${escapeHtmlKP(kategori)}</span>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.6px; opacity:0.85; font-weight:600;">Sisa Saldo Piutang (Total)</div>
                        <div style="font-size:22px; font-weight:800; color:#ffffff; margin-top:2px;">Rp ${nf.format(Math.abs(grandSisaSaldo))}${grandSisaSaldo < 0 ? ' (Deposit)' : ''}</div>
                    </div>
                </div>
                ${diagramHtml}
            </div>
        `;
        summaryCard.classList.remove('hidden');
    }

    let state = getKPState(prefix);
    let cached = state.getCached();
    if (!state.getSelectedDates() || !cached || cached.namaKonsumen !== namaKonsumen || cached.periode !== periode) {
        state.setSelectedDates(new Set(allEventDates));
    }

    state.setCached({
        data,
        tagihanArr,
        bayarArr,
        arrNota,
        timeline,
        namaKonsumen,
        periode,
        allEventDates
    });

    populateMultiDateDropdownGeneric(prefix, allEventDates, timeline, periode);
    renderKartuPiutangTableGeneric(prefix);
}

// Render Isi Tabel Kartu Piutang
function renderKartuPiutangTableGeneric(prefix) {
    let state = getKPState(prefix);
    let cached = state.getCached();
    if (!cached) return;

    let { tagihanArr, bayarArr, timeline, periode, allEventDates } = cached;
    let tbody = document.getElementById(`${prefix}-tbody`);
    let tfoot = document.getElementById(`${prefix}-tfoot`);
    let tableContainer = document.getElementById(`${prefix}-table-container`);
    let emptyState = document.getElementById(`${prefix}-empty-state`);
    let nf = new Intl.NumberFormat('id-ID');

    let selectedDates = state.getSelectedDates();
    if (!selectedDates) {
        selectedDates = new Set(allEventDates);
        state.setSelectedDates(selectedDates);
    }

    let isPartialDateFilter = (allEventDates.length > 0 && selectedDates.size < allEventDates.length);
    let sortedSelectedDates = Array.from(selectedDates).sort();
    let firstSelectedDate = sortedSelectedDates[0] || '';

    // Hitung Saldo Awal Tahun jika bukan ALL secara konsisten dengan alur timeline
    // Hitung Saldo Awal Tahun jika bukan ALL secara murni berdasarkan tanggal cut-off kalender (< 1 Jan tahun berjalan)
    let saldoAwalTahun = 0;
    if (periode !== 'ALL') {
        let startYearStr = `${periode}-01-01`;
        tagihanArr.filter(t => t.tgl < startYearStr).forEach(t => saldoAwalTahun += t.nominal);
        bayarArr.filter(b => b.tgl < startYearStr).forEach(b => saldoAwalTahun -= b.nominal);
    }

    let isPortal = (prefix === 'portal-kp');
    let periodTagihan = 0;
    let periodBayar = 0;
    let rowsHtml = '';
    let rowCount = 0;

    let saldoSebelumFirstSelected = saldoAwalTahun;
    if (isPartialDateFilter && firstSelectedDate) {
        tagihanArr.filter(t => (periode === 'ALL' || t.tgl.startsWith(periode)) && t.tgl < firstSelectedDate).forEach(t => saldoSebelumFirstSelected += t.nominal);
        bayarArr.filter(b => (periode === 'ALL' || b.tgl.startsWith(periode)) && b.tgl < firstSelectedDate).forEach(b => saldoSebelumFirstSelected -= b.nominal);
    }

    let runningSaldo = (isPartialDateFilter && firstSelectedDate) ? saldoSebelumFirstSelected : saldoAwalTahun;

    // Baris Saldo Awal
    if (isPartialDateFilter && firstSelectedDate && selectedDates.size > 0) {
        let saldoStr = saldoSebelumFirstSelected < 0 ? `-Rp ${nf.format(Math.abs(saldoSebelumFirstSelected))}` : `Rp ${nf.format(saldoSebelumFirstSelected)}`;
        if (isPortal) {
            rowsHtml += `
                <tr style="background:#f1f5f9; font-weight:bold; border-bottom:2px solid #cbd5e1;">
                    <td style="text-align:center; padding:9px 6px; color:#475569; font-size:11px;">-</td>
                    <td style="padding:9px 8px; color:#1e3a8a;">
                        <div style="font-weight:700; font-size:12px;">SALDO AWAL (SEBELUM ${fmtTglKP(firstSelectedDate)})</div>
                        <div style="font-size:10px; color:#64748b; font-weight:normal;">Akumulasi s.d tanggal terpilih</div>
                    </td>
                    <td style="text-align:right; padding:9px 8px; color:#94a3b8; font-size:11px;">-</td>
                    <td style="text-align:right; padding:9px 8px; font-weight:700; color:#1e293b; font-size:11px;">${saldoStr}</td>
                </tr>
            `;
        } else {
            rowsHtml += `
                <tr style="background:#f1f5f9; font-weight:bold; border-bottom:2px solid #cbd5e1;">
                    <td style="text-align:center; padding:10px 8px; color:#475569;">-</td>
                    <td style="padding:10px 12px; color:#1e3a8a;">
                        <div style="font-weight:700;">SALDO AWAL (SEBELUM ${fmtTglKP(firstSelectedDate)})</div>
                        <div style="font-size:10px; color:#64748b; font-weight:normal;">Akumulasi transaksi sebelum tanggal terpilih</div>
                    </td>
                    <td style="text-align:right; padding:10px; color:#94a3b8;">-</td>
                    <td style="text-align:right; padding:10px; color:#94a3b8;">-</td>
                    <td style="text-align:right; padding:10px; font-weight:700; color:#1e293b;">${saldoStr}</td>
                </tr>
            `;
        }
    } else if (periode !== 'ALL' && (!isPartialDateFilter || selectedDates.size > 0)) {
        let saldoAwalStr = saldoAwalTahun < 0 ? `-Rp ${nf.format(Math.abs(saldoAwalTahun))}` : `Rp ${nf.format(saldoAwalTahun)}`;
        if (isPortal) {
            rowsHtml += `
                <tr style="background:#f1f5f9; font-weight:bold; border-bottom:2px solid #cbd5e1;">
                    <td style="text-align:center; padding:9px 6px; color:#475569; font-size:11px;">-</td>
                    <td style="padding:9px 8px; color:#1e3a8a;">
                        <div style="font-weight:700; font-size:12px;">SALDO AWAL TAHUN ${periode}</div>
                        <div style="font-size:10px; color:#64748b; font-weight:normal;">Bawaan per 1 Januari ${periode}</div>
                    </td>
                    <td style="text-align:right; padding:9px 8px; color:#94a3b8; font-size:11px;">-</td>
                    <td style="text-align:right; padding:9px 8px; font-weight:700; color:#1e293b; font-size:11px;">${saldoAwalStr}</td>
                </tr>
            `;
        } else {
            rowsHtml += `
                <tr style="background:#f1f5f9; font-weight:bold; border-bottom:2px solid #cbd5e1;">
                    <td style="text-align:center; padding:10px 8px; color:#475569;">-</td>
                    <td style="padding:10px 12px; color:#1e3a8a;">
                        <div style="font-weight:700;">SALDO AWAL TAHUN ${periode}</div>
                        <div style="font-size:10px; color:#64748b; font-weight:normal;">Saldo bawaan per 1 Januari ${periode}</div>
                    </td>
                    <td style="text-align:right; padding:10px; color:#94a3b8;">-</td>
                    <td style="text-align:right; padding:10px; color:#94a3b8;">-</td>
                    <td style="text-align:right; padding:10px; font-weight:700; color:#1e293b;">${saldoAwalStr}</td>
                </tr>
            `;
        }
    }

    let colSpanTotal = isPortal ? 4 : 5;

    if (selectedDates.size === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="${colSpanTotal}" style="text-align:center; padding:30px; color:#64748b; font-style:italic;">Tidak ada tanggal yang dipilih pada filter tanggal.</td></tr>`;
        if (tfoot) {
            if (isPortal) {
                tfoot.innerHTML = `
                    <tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">
                        <td colspan="2" style="text-align:right; padding:10px 8px; color:#334155; font-size:11px; font-weight:800;">TOTAL MUTASI:</td>
                        <td style="text-align:right; padding:10px 8px; color:#1e293b; font-size:11px; font-weight:800;">Rp 0</td>
                        <td style="text-align:right; padding:10px 8px; color:#1e293b; font-size:11px; font-weight:800;">Rp 0</td>
                    </tr>
                `;
            } else {
                tfoot.innerHTML = `
                    <tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">
                        <td colspan="2" style="text-align:right; padding:12px 10px; color:#334155; font-size:12px; font-weight:800; text-transform:uppercase;">TOTAL MUTASI:</td>
                        <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp 0</td>
                        <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp 0</td>
                        <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:13px; font-weight:800;">Rp 0</td>
                    </tr>
                `;
            }
        }
        tableContainer?.classList.remove('hidden');
        emptyState?.classList.add('hidden');
        return;
    }

    // Render Events
    timeline.forEach(event => {
        if (event.type === 'NOTA') {
            let isNotaInPeriod = (periode === 'ALL' || event.nota.tgl.startsWith(periode));
            if (isNotaInPeriod) {
                let isDateSelected = selectedDates.has(event.nota.tgl);
                event.nota.items.forEach(it => {
                    let isBeforeFirst = (isPartialDateFilter && firstSelectedDate && it.tgl < firstSelectedDate);
                    if (!isBeforeFirst) {
                        runningSaldo += it.nominal;
                    }
                    if (isDateSelected) {
                        periodTagihan += it.nominal;
                        rowCount++;

                        let bg = rowCount % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";
                        let ketHtml = '';
                        if (it.isOngkir) {
                            ketHtml = `
                                <div style="font-weight:700; color:#1e293b;">Ongkir Pengiriman</div>
                                <div style="font-size:11px; color:#64748b; margin-top:1px;">1 Rit x @${nf.format(it.nominal)}</div>
                            `;
                        } else if (it.isTarikDeposit) {
                            ketHtml = `
                                <div style="font-weight:700; color:#b45309;">${escapeHtmlKP(it.pakan)}</div>
                                <div style="font-size:11px; color:#64748b; margin-top:1px;">Penyesuaian Saldo Kas / Deposit</div>
                            `;
                        } else {
                            ketHtml = `
                                <div style="font-weight:700; color:#1e293b;">${escapeHtmlKP(it.pakan)}</div>
                                <div style="font-size:11px; color:#64748b; margin-top:1px;">${nf.format(it.qty)} ${escapeHtmlKP(it.satuan)} x @${nf.format(it.harga_satuan)}</div>
                            `;
                        }

                        let saldoDisplay = runningSaldo < 0 ? `-Rp ${nf.format(Math.abs(runningSaldo))}` : `Rp ${nf.format(runningSaldo)}`;
                        if (isPortal) {
                            rowsHtml += `
                                <tr style="${bg} border-bottom:1px solid #e2e8f0; vertical-align: top;">
                                    <td style="text-align:center; padding:8px 6px; color:#475569; font-size:11px; white-space:nowrap;">${fmtTglKP(it.tgl)}</td>
                                    <td style="padding:8px 8px; line-height:1.35;">${ketHtml}</td>
                                    <td style="text-align:right; padding:8px 6px; font-weight:700; color:#1e293b; font-size:11px; white-space:nowrap;">+ Rp ${nf.format(it.nominal)}</td>
                                    <td style="text-align:right; padding:8px 6px; font-weight:700; color:#1e293b; font-size:11px; white-space:nowrap;">${saldoDisplay}</td>
                                </tr>
                            `;
                        } else {
                            rowsHtml += `
                                <tr style="${bg} border-bottom:1px solid #e2e8f0; vertical-align: top;">
                                    <td style="text-align:center; padding:9px 8px; color:#475569; font-size:11px;">${fmtTglKP(it.tgl)}</td>
                                    <td style="padding:9px 12px; line-height:1.35;">${ketHtml}</td>
                                    <td style="text-align:right; padding:9px 10px; font-weight:700; color:#1e293b;">Rp ${nf.format(it.nominal)}</td>
                                    <td style="text-align:right; padding:9px 10px; color:#94a3b8;">-</td>
                                    <td style="text-align:right; padding:9px 10px; font-weight:700; color:#1e293b;">${saldoDisplay}</td>
                                </tr>
                            `;
                        }
                    }
                });
            }

            if (event.attachedPayments && event.attachedPayments.length > 0) {
                event.attachedPayments.forEach(b => {
                    let isPaymentInPeriod = (periode === 'ALL' || b.tgl.startsWith(periode));
                    if (isPaymentInPeriod) {
                        let isBeforeFirst = (isPartialDateFilter && firstSelectedDate && b.tgl < firstSelectedDate);
                        if (!isBeforeFirst) {
                            runningSaldo -= b.nominal;
                        }
                        let isDateSelected = selectedDates.has(b.tgl);
                        if (isDateSelected) {
                            periodBayar += b.nominal;
                            rowCount++;

                            let bg = rowCount % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";
                            let linkBukti = b.bukti_url 
                                ? `<a href="${b.bukti_url}" target="_blank" style="margin-left:6px; color:#2563eb; text-decoration:none; display:inline-flex; align-items:center; gap:2px; font-size:10px; font-weight:600;"><span class="material-symbols-outlined" style="font-size:13px;">receipt_long</span> Bukti</a>` 
                                : '';
                            
                            let labelBayar = b.metode === "Retur Barang" ? `Retur Barang` : `Pembayaran (${escapeHtmlKP(b.metode || 'Cash')})`;
                            let colorBayar = b.metode === "Retur Barang" ? "#b45309" : "#15803d";

                            let ketBayar = `
                                <div style="font-weight:700; color:${colorBayar}; display:flex; align-items:center; flex-wrap:wrap;">
                                    <span>${labelBayar}</span>
                                    ${linkBukti}
                                </div>
                            `;

                            if (b.keterangan && b.keterangan !== '-') {
                                ketBayar += `<div style="font-size:10px; color:#64748b; font-style:italic; margin-top:1px;">${escapeHtmlKP(b.keterangan)}</div>`;
                            }

                            let saldoDisplay = runningSaldo < 0 ? `-Rp ${nf.format(Math.abs(runningSaldo))}` : `Rp ${nf.format(runningSaldo)}`;
                            if (isPortal) {
                                rowsHtml += `
                                    <tr style="${bg} border-bottom:1px solid #e2e8f0; vertical-align: top;">
                                        <td style="text-align:center; padding:8px 6px; color:#475569; font-size:11px; white-space:nowrap;">${fmtTglKP(b.tgl)}</td>
                                        <td style="padding:8px 8px; line-height:1.35;">${ketBayar}</td>
                                        <td style="text-align:right; padding:8px 6px; font-weight:700; color:#15803d; font-size:11px; white-space:nowrap;">- Rp ${nf.format(b.nominal)}</td>
                                        <td style="text-align:right; padding:8px 6px; font-weight:700; color:#1e293b; font-size:11px; white-space:nowrap;">${saldoDisplay}</td>
                                    </tr>
                                `;
                            } else {
                                rowsHtml += `
                                    <tr style="${bg} border-bottom:1px solid #e2e8f0; vertical-align: top;">
                                        <td style="text-align:center; padding:9px 8px; color:#475569; font-size:11px;">${fmtTglKP(b.tgl)}</td>
                                        <td style="padding:9px 12px; line-height:1.35;">${ketBayar}</td>
                                        <td style="text-align:right; padding:9px 10px; color:#94a3b8;">-</td>
                                        <td style="text-align:right; padding:9px 10px; font-weight:700; color:#1e293b;">Rp ${nf.format(b.nominal)}</td>
                                        <td style="text-align:right; padding:9px 10px; font-weight:700; color:#1e293b;">${saldoDisplay}</td>
                                    </tr>
                                `;
                            }
                        }
                    }
                });
            }
        } else if (event.type === 'STANDALONE_PAYMENT') {
            let b = event.payment;
            let isPaymentInPeriod = (periode === 'ALL' || b.tgl.startsWith(periode));
            if (isPaymentInPeriod) {
                let isBeforeFirst = (isPartialDateFilter && firstSelectedDate && b.tgl < firstSelectedDate);
                if (!isBeforeFirst) {
                    runningSaldo -= b.nominal;
                }
                let isDateSelected = selectedDates.has(b.tgl);
                if (isDateSelected) {
                    periodBayar += b.nominal;
                    rowCount++;

                    let bg = rowCount % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";
                    let linkBukti = b.bukti_url 
                        ? `<a href="${b.bukti_url}" target="_blank" style="margin-left:6px; color:#2563eb; text-decoration:none; display:inline-flex; align-items:center; gap:2px; font-size:10px; font-weight:600;"><span class="material-symbols-outlined" style="font-size:13px;">receipt_long</span> Bukti</a>` 
                        : '';

                    let labelBayar = b.metode === "Retur Barang" ? `Retur Barang` : `Pembayaran / Deposit (${escapeHtmlKP(b.metode || 'Cash')})`;
                    let colorBayar = b.metode === "Retur Barang" ? "#b45309" : "#0369a1";

                    let ketBayar = `
                        <div style="font-weight:700; color:${colorBayar}; display:flex; align-items:center; flex-wrap:wrap;">
                            <span>${labelBayar}</span>
                            ${linkBukti}
                        </div>
                    `;

                    if (b.keterangan && b.keterangan !== '-') {
                        ketBayar += `<div style="font-size:10px; color:#64748b; margin-top:2px;">${escapeHtmlKP(b.keterangan)}</div>`;
                    }

                    let saldoDisplay = runningSaldo < 0 ? `-Rp ${nf.format(Math.abs(runningSaldo))}` : `Rp ${nf.format(runningSaldo)}`;
                    if (isPortal) {
                        rowsHtml += `
                            <tr style="${bg} border-bottom:1px solid #e2e8f0; vertical-align: top;">
                                <td style="text-align:center; padding:8px 6px; color:#475569; font-size:11px; white-space:nowrap;">${fmtTglKP(b.tgl)}</td>
                                <td style="padding:8px 8px; line-height:1.35;">${ketBayar}</td>
                                <td style="text-align:right; padding:8px 6px; font-weight:700; color:#15803d; font-size:11px; white-space:nowrap;">- Rp ${nf.format(b.nominal)}</td>
                                <td style="text-align:right; padding:8px 6px; font-weight:700; color:#1e293b; font-size:11px; white-space:nowrap;">${saldoDisplay}</td>
                            </tr>
                        `;
                    } else {
                        rowsHtml += `
                            <tr style="${bg} border-bottom:1px solid #e2e8f0; vertical-align: top;">
                                <td style="text-align:center; padding:9px 8px; color:#475569; font-size:11px;">${fmtTglKP(b.tgl)}</td>
                                <td style="padding:9px 12px; line-height:1.35;">${ketBayar}</td>
                                <td style="text-align:right; padding:9px 10px; color:#94a3b8;">-</td>
                                <td style="text-align:right; padding:9px 10px; font-weight:700; color:#1e293b;">Rp ${nf.format(b.nominal)}</td>
                                <td style="text-align:right; padding:9px 10px; font-weight:700; color:#1e293b;">${saldoDisplay}</td>
                            </tr>
                        `;
                    }
                }
            }
        }
    });

    if (tbody) {
        if (rowCount === 0) {
            tbody.innerHTML = `<tr><td colspan="${colSpanTotal}" style="text-align:center; padding:25px; color:#64748b; font-style:italic;">Tidak ada transaksi dalam filter yang dipilih.</td></tr>`;
        } else {
            tbody.innerHTML = rowsHtml;
        }
    }

    // TFoot
    if (tfoot) {
        let finalSaldoStr = runningSaldo < 0 ? `-Rp ${nf.format(Math.abs(runningSaldo))}` : `Rp ${nf.format(runningSaldo)}`;
        if (isPortal) {
            let labelTFoot = isPartialDateFilter 
                ? 'TOTAL:' 
                : `TOTAL ${periode === 'ALL' ? '' : 'TAHUN ' + periode}:`;
            tfoot.innerHTML = `
                <tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">
                    <td colspan="2" style="text-align:right; padding:10px 8px; color:#334155; font-size:11px; font-weight:800; text-transform:uppercase;">${labelTFoot}</td>
                    <td style="text-align:right; padding:10px 8px; font-size:11px; font-weight:800; line-height:1.3; white-space:nowrap;">
                        <span style="color:#1e293b;">+Rp ${nf.format(periodTagihan)}</span><br>
                        <span style="color:#15803d;">-Rp ${nf.format(periodBayar)}</span>
                    </td>
                    <td style="text-align:right; padding:10px 8px; color:#1e293b; font-size:12px; font-weight:800; white-space:nowrap;">${finalSaldoStr}</td>
                </tr>
            `;
        } else {
            let labelTFoot = isPartialDateFilter 
                ? 'TOTAL MUTASI (TANGGAL TERPILIH):' 
                : `TOTAL MUTASI ${periode === 'ALL' ? 'KESELURUHAN' : 'TAHUN ' + periode}:`;

            tfoot.innerHTML = `
                <tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">
                    <td colspan="2" style="text-align:right; padding:12px 10px; color:#334155; font-size:12px; font-weight:800; text-transform:uppercase;">${labelTFoot}</td>
                    <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp ${nf.format(periodTagihan)}</td>
                    <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp ${nf.format(periodBayar)}</td>
                    <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:13px; font-weight:800;">${finalSaldoStr}</td>
                </tr>
            `;
        }
    }

    tableContainer?.classList.remove('hidden');
    emptyState?.classList.add('hidden');
}

// Tutup Dropdown saat klik di luar area
document.addEventListener('click', function(e) {
    ['kp', 'portal-kp'].forEach(prefix => {
        let dropdown = document.getElementById(`${prefix}-multidate-dropdown`);
        let btn = document.getElementById(`${prefix}-multidate-btn`);
        if (dropdown && !dropdown.classList.contains('hidden')) {
            if (!dropdown.contains(e.target) && !btn?.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        }
    });
});

// Wrappers untuk Jurnal ('kp')
function prosesDanRenderKartuPiutang(data, namaKonsumen, periode) {
    prosesDanRenderKartuPiutangGeneric('kp', data, namaKonsumen, periode);
}
function renderKartuPiutangTable() {
    renderKartuPiutangTableGeneric('kp');
}
function toggleMultiDateDropdownKP(e) {
    toggleMultiDateDropdownGeneric('kp', e);
}
function toggleSelectAllDatesKP(checked) {
    toggleSelectAllDatesGeneric('kp', checked);
}
function onDateCheckboxChangeKP() {
    onDateCheckboxChangeGeneric('kp');
}
function onPeriodChangeKP() {
    onPeriodChangeGeneric('kp');
}

// Wrappers untuk Portal Konsumen ('portal-kp')
function prosesDanRenderKartuPiutangPortal(data, namaKonsumen, periode) {
    prosesDanRenderKartuPiutangGeneric('portal-kp', data, namaKonsumen, periode);
}
function renderKartuPiutangTablePortal() {
    renderKartuPiutangTableGeneric('portal-kp');
}
function toggleMultiDateDropdownPortalKP(e) {
    toggleMultiDateDropdownGeneric('portal-kp', e);
}
function toggleSelectAllDatesPortalKP(checked) {
    toggleSelectAllDatesGeneric('portal-kp', checked);
}
function onDateCheckboxChangePortalKP() {
    onDateCheckboxChangeGeneric('portal-kp');
}
function onPeriodChangePortalKP() {
    onPeriodChangeGeneric('portal-kp');
}
function bukaModalCetakPortalKP() {
    let namaKonsumen = document.getElementById('analytics_relasi')?.value?.trim();
    if (!namaKonsumen) {
        alert("Nama konsumen / peternak belum terdeteksi. Silakan muat ulang halaman.");
        return;
    }
    window.cetakSource = 'portal_kartu_piutang';

    let kpInp = document.getElementById('kp-filter-konsumen');
    if (kpInp) kpInp.value = namaKonsumen;

    let formatCont = document.getElementById('es-cetak-format-container');
    if (formatCont) formatCont.style.display = 'block';
    let selFormat = document.getElementById('es-cetak-format');
    if (selFormat) selFormat.value = 'simple';

    let curPeriode = document.getElementById('portal-kp-filter-periode')?.value || '2026';
    if (curPeriode && curPeriode !== 'ALL') {
        let selTipe = document.getElementById('es-cetak-tipe');
        if (selTipe) selTipe.value = 'tahun';
        if (typeof toggleInputCetakES === 'function') toggleInputCetakES();
        let selTahun = document.getElementById('es-cetak-tahun');
        if (selTahun) selTahun.value = curPeriode;
    }
    document.getElementById('modal-pengaturan-cetak-es')?.classList.remove('hidden');
}

// Expose fungsi ke window agar dapat dipanggil dari inline HTML
window.muatKartuPiutang = muatKartuPiutang;
window.prosesDanRenderKartuPiutang = prosesDanRenderKartuPiutang;
window.renderKartuPiutangTable = renderKartuPiutangTable;
window.toggleMultiDateDropdownKP = toggleMultiDateDropdownKP;
window.toggleSelectAllDatesKP = toggleSelectAllDatesKP;
window.onDateCheckboxChangeKP = onDateCheckboxChangeKP;
window.onPeriodChangeKP = onPeriodChangeKP;

window.prosesDanRenderKartuPiutangPortal = prosesDanRenderKartuPiutangPortal;
window.renderKartuPiutangTablePortal = renderKartuPiutangTablePortal;
window.toggleMultiDateDropdownPortalKP = toggleMultiDateDropdownPortalKP;
window.toggleSelectAllDatesPortalKP = toggleSelectAllDatesPortalKP;
window.onDateCheckboxChangePortalKP = onDateCheckboxChangePortalKP;
window.onPeriodChangePortalKP = onPeriodChangePortalKP;
window.bukaModalCetakPortalKP = bukaModalCetakPortalKP;


// =========================================================================
// SUB-MENU 1: DATA MENTAH SIAP JURNAL (ADMIN 2 AUDIT & STAGING)
// =========================================================================

let dataMentahGlobal = [];
let mentahEditingRow = null;

function initTanggalMentah() {
    let selBulan = document.getElementById('mentah-bulan');
    let selTahun = document.getElementById('mentah-tahun');
    if (selBulan && (!selBulan.value || selBulan.value === 'ALL')) {
        let now = new Date();
        selBulan.value = ("0" + (now.getMonth() + 1)).slice(-2);
        if (selTahun) selTahun.value = now.getFullYear();
    }
}

function klasifikasiKategoriPakan(r) {
    let stat = (r.status || '').toLowerCase();
    let rel = (r.relasi || '').toLowerCase().trim();
    let cab = (r.cabang || '').trim();
    let cat = (r.catatan || '').toLowerCase();
    let hsh = (r.hash_str || '');

    if (stat.includes('masuk')) {
        if (cat.includes('[auto mutasi]') || hsh.includes('_AUTO_IN') || 
            (['Kandang PM', 'Kandang SPN', 'SPN', 'PM', 'RPH'].includes(cab) && ['kandang', 'pm', 'spn', 'rph'].includes(rel) && !cat.includes('(supplier:'))) {
            return 'MUTASI';
        }
        return 'MASUK'; // 4. Barang Masuk
    }

    if (stat.includes('keluar')) {
        if (['kandang', 'spn', 'pm', 'rph', 'pembibitan', 'gudang pm', 'gudang spn', 'gudang rph'].includes(rel) || 
            cat.includes('mutasi') || hsh.includes('AUTO_OUT') || hsh.includes('AUTO_IN')) {
            return 'MUTASI'; // 3. Mutasi
        }
        if (['Kandang PM', 'Kandang SPN'].includes(cab) || 
            (cab === 'SPN' && ['rd', 'rl', 'jantan', 'dewasa', 'kapalang', 'bunting', 'pedet', 'kerbau', 'domba', 'bx', 'kambing'].includes(rel)) || 
            ['jantan', 'dewasa', 'kapalang', 'bunting', 'pedet', 'kerbau', 'domba', 'bx', 'kambing', 'sapi campur', 'cibulakan'].includes(rel)) {
            return 'PAKAI'; // 2. Pemakaian
        }
        return 'JUAL'; // 1. Penjualan
    }

    return 'JUAL';
}

function auditDataMentahPakan(r, kat) {
    let pakanLow = (r.pakan || '').toLowerCase();
    let isOngkir = pakanLow.includes('ongkir');
    let hpp = Number(r.total_hpp) || 0;
    let qty = Number(r.qty) || 0;
    let defisit = Number(r.qty_defisit) || 0;
    let rel = (r.relasi || '').trim();

    if (!rel || rel === '-' || rel === 'Umum') {
        return { status: 'ANOMALI', code: 'RELASI', label: 'Relasi Kosong', badgeBg: '#fff7ed', badgeColor: '#c2410c', pesan: 'Nama relasi belum dipilih' };
    }

    // Jasa Ongkir pengiriman tidak memiliki stok fisik & bukan defisit
    if (isOngkir) {
        return { status: 'VALID', code: 'VALID', label: 'Non-Stok (Ongkir)', badgeBg: '#f1f5f9', badgeColor: '#475569', pesan: 'Jasa ongkir pengiriman' };
    }

    if (defisit > 0) {
        return { status: 'ANOMALI', code: 'DEFISIT', label: `Defisit ${defisit} Kg`, badgeBg: '#fef2f2', badgeColor: '#b91c1c', pesan: `Kekurangan stok fisik ${defisit} Kg saat pengeluaran` };
    }

    if ((kat === 'JUAL' || kat === 'PAKAI') && qty > 0 && hpp === 0) {
        return { status: 'ANOMALI', code: 'HPP_0', label: 'HPP Nol', badgeBg: '#fefce8', badgeColor: '#a16207', pesan: 'Pengeluaran fisik tapi HPP Rp 0 (cek batch)' };
    }

    return { status: 'VALID', code: 'VALID', label: 'Siap Jurnal', badgeBg: '#f0fdf4', badgeColor: '#15803d', pesan: 'Data lengkap & valid' };
}

function tandaiDuplikatMentah(rows) {
    let seen = {};
    rows.forEach(r => {
        if (r.source !== 'transaksi_pakan') return;
        let key = `${r.tanggal}_${r.relasi}_${r.pakan}_${r.qty}_${r.harga_satuan}_${r.cabang}`;
        if (seen[key]) {
            r.audit = { status: 'ANOMALI', code: 'DUPLIKAT', label: 'Potensi Dobel', badgeBg: '#fef2f2', badgeColor: '#b91c1c', pesan: 'Transaksi identik terdeteksi di tanggal yang sama' };
            seen[key].audit = { status: 'ANOMALI', code: 'DUPLIKAT', label: 'Potensi Dobel', badgeBg: '#fef2f2', badgeColor: '#b91c1c', pesan: 'Transaksi identik terdeteksi di tanggal yang sama' };
        } else {
            seen[key] = r;
        }
    });
}

async function fetchDataMentah() {
    let loader = document.getElementById('mentah-loader');
    loader?.classList.remove('hidden');

    try {
        let bulan = document.getElementById('mentah-bulan')?.value || 'ALL';
        let tahun = document.getElementById('mentah-tahun')?.value || new Date().getFullYear();

        let startDate = `${tahun}-01-01`;
        let endDate = `${tahun}-12-31`;
        if (bulan && bulan !== 'ALL') {
            let lastDay = new Date(tahun, Number(bulan), 0).getDate();
            startDate = `${tahun}-${bulan}-01`;
            endDate = `${tahun}-${bulan}-${("0" + lastDay).slice(-2)}`;
        }

        let headers = {
            'apikey': SUPA_ANON_KEY,
            'Authorization': `Bearer ${SUPA_ANON_KEY}`
        };

        let [rowsPakan, rowsCF] = await Promise.all([
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.desc,id.desc`, headers),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/cashflow?tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.desc,id.desc`, headers)
        ]);

        let combined = [];

        rowsPakan.forEach(r => {
            let rel = (r.relasi || '').trim();
            if (rel.toLowerCase().includes('bapera')) return;

            let kat = klasifikasiKategoriPakan(r);
            let audit = auditDataMentahPakan(r, kat);

            combined.push({
                source: 'transaksi_pakan',
                id: r.id,
                tanggal: r.tanggal,
                waktu: r.waktu_input || '',
                cabang: r.cabang || '-',
                kategori: kat,
                relasi: rel || '-',
                pakan: r.pakan || '-',
                qty: Number(r.qty) || 0,
                satuan: r.satuan || 'Kg',
                harga_satuan: Number(r.harga_satuan) || 0,
                total_nilai: (Number(r.qty) || 0) * (Number(r.harga_satuan) || 0),
                total_hpp: Number(r.total_hpp) || 0,
                qty_defisit: Number(r.qty_defisit) || 0,
                catatan: r.catatan || '',
                audit: audit,
                raw: r
            });
        });

        rowsCF.forEach(c => {
            let rel = (c.relasi || '').trim();
            if (rel.toLowerCase().includes('bapera')) return;

            let isMasuk = (c.jenis || '').toLowerCase().includes('masuk');
            let kat = 'KAS';
            let nom = Number(c.nominal) || 0;
            let audit = {
                status: 'VALID',
                code: 'VALID',
                label: 'Kas ' + (isMasuk ? 'Masuk' : 'Keluar'),
                badgeBg: '#eff6ff',
                badgeColor: '#1d4ed8',
                pesan: 'Transaksi Kas / Pembayaran'
            };

            combined.push({
                source: 'cashflow',
                id: c.id,
                tanggal: c.tanggal,
                waktu: '',
                cabang: c.kategori || 'Kasir',
                kategori: kat,
                relasi: rel || 'Umum',
                pakan: c.keterangan || (isMasuk ? 'Penerimaan Kas / Piutang' : 'Pengeluaran Kas'),
                qty: 1,
                satuan: 'Tx',
                harga_satuan: nom,
                total_nilai: nom,
                total_hpp: 0,
                qty_defisit: 0,
                catatan: c.keterangan || '',
                audit: audit,
                raw: c
            });
        });

        combined.sort((a, b) => {
            if (a.tanggal !== b.tanggal) return b.tanggal.localeCompare(a.tanggal);
            return b.id - a.id;
        });

        tandaiDuplikatMentah(combined);

        dataMentahGlobal = combined;
        renderDataMentah();
    } catch (err) {
        console.error("Gagal memuat data mentah:", err);
        alert("Gagal memuat data mentah: " + err.message);
    } finally {
        loader?.classList.add('hidden');
    }
}

// ==========================================
// SPREADSHEET-STYLE HEADER COLUMN FILTERS
// ==========================================
let ssFilterState = {
    jurnal: {
        kode: null,
        perkiraan: null,
        relasi: null
    },
    mentah: {
        kategori: null,
        cabang: null,
        audit: null
    },
    outflow: {
        cabang: null,
        status: null
    },
    inflow: {
        cabang: null,
        status: null
    }
};

let currentOpenFilter = {
    context: null,
    field: null,
    distinctValues: [],
    tempSelected: new Set()
};

function toggleHeaderFilter(event, context, field) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    let popover = document.getElementById('spreadsheet-filter-popover');
    if (!popover) return;

    if (!popover.classList.contains('hidden') && currentOpenFilter.context === context && currentOpenFilter.field === field) {
        closeHeaderFilter();
        return;
    }

    currentOpenFilter.context = context;
    currentOpenFilter.field = field;

    let distinctMap = {};
    let title = "Filter Kolom";

    if (context === 'mentah') {
        let rows = dataMentahGlobal || [];
        if (field === 'kategori') {
            title = "Filter Kategori Transaksi";
            let mapKatLabels = {
                'JUAL': 'Penjualan',
                'PAKAI': 'Pemakaian',
                'MUTASI': 'Mutasi',
                'MASUK': 'Barang Masuk',
                'KAS': 'Kas & Bank'
            };
            rows.forEach(r => {
                let k = r.kategori || 'LAIN';
                let lbl = mapKatLabels[k] || k;
                if (!distinctMap[k]) distinctMap[k] = { val: k, label: lbl, count: 0 };
                distinctMap[k].count++;
            });
        } else if (field === 'cabang') {
            title = "Filter Cabang";
            rows.forEach(r => {
                let c = r.cabang || '-';
                if (!distinctMap[c]) distinctMap[c] = { val: c, label: c, count: 0 };
                distinctMap[c].count++;
            });
        } else if (field === 'audit') {
            title = "Filter Status Audit";
            rows.forEach(r => {
                let code = r.audit ? r.audit.code : 'VALID';
                let lbl = r.audit ? r.audit.label : 'Siap Jurnal';
                if (!distinctMap[code]) distinctMap[code] = { val: code, label: lbl, count: 0 };
                distinctMap[code].count++;
            });
        }
    } else if (context === 'outflow') {
        let rows = hppOutflowGlobal || [];
        if (field === 'cabang') {
            title = "Filter Cabang";
            rows.forEach(r => {
                let c = r.cabang || '-';
                if (!distinctMap[c]) distinctMap[c] = { val: c, label: c, count: 0 };
                distinctMap[c].count++;
            });
        } else if (field === 'status') {
            title = "Filter Status FIFO";
            rows.forEach(r => {
                let isOngkir = (r.pakan || '').toLowerCase().includes('ongkir');
                let st = isOngkir ? 'Non-Stok' : (Number(r.total_hpp) > 0 ? 'Ter-Cover' : 'Defisit');
                if (!distinctMap[st]) distinctMap[st] = { val: st, label: st, count: 0 };
                distinctMap[st].count++;
            });
        }
    } else if (context === 'inflow') {
        let rows = hppInflowGlobal || [];
        if (field === 'cabang') {
            title = "Filter Cabang";
            rows.forEach(b => {
                let c = b.cabang || '-';
                if (!distinctMap[c]) distinctMap[c] = { val: c, label: c, count: 0 };
                distinctMap[c].count++;
            });
        } else if (field === 'status') {
            title = "Filter Status Batch";
            rows.forEach(b => {
                let stObj = getBatchStatus(b);
                if (!distinctMap[stObj.code]) distinctMap[stObj.code] = { val: stObj.code, label: stObj.label, count: 0 };
                distinctMap[stObj.code].count++;
            });
        }
    } else if (context === 'jurnal') {
        let rows = jurnalDataGlobal || [];
        const kodeLabels = {
            '1': '1 - Aset / Piutang / Kas',
            '2': '2 - Kewajiban / Hutang',
            '3': '3 - Ekuitas / Modal',
            '4': '4 - Pendapatan Penjualan',
            '5': '5 - Biaya / HPP'
        };
        if (field === 'kode') {
            title = "Filter KODE Akun";
            rows.forEach(r => {
                let k = r.kode_akun ? String(r.kode_akun).charAt(0) : '-';
                if (!distinctMap[k]) distinctMap[k] = { val: k, label: kodeLabels[k] || k, count: 0 };
                distinctMap[k].count++;
            });
        } else if (field === 'perkiraan') {
            title = "Filter Perkiraan";
            rows.forEach(r => {
                let p = (r.nama_akun || '').trim() || '-';
                if (!distinctMap[p]) distinctMap[p] = { val: p, label: p, count: 0 };
                distinctMap[p].count++;
            });
        } else if (field === 'relasi') {
            title = "Filter Relasi";
            rows.forEach(r => {
                let tokens = getJurnalRelasiTokens(r.relasi);
                let seenInRow = new Set();
                tokens.forEach(tok => {
                    if (seenInRow.has(tok)) return;
                    seenInRow.add(tok);
                    let lbl = tok === '__EMPTY__' ? '(Tanpa Relasi)' : tok;
                    if (!distinctMap[tok]) distinctMap[tok] = { val: tok, label: lbl, count: 0 };
                    distinctMap[tok].count++;
                });
            });
        }
    }

    currentOpenFilter.distinctValues = Object.values(distinctMap).sort((a, b) => a.label.localeCompare(b.label, 'id'));

    let activeSaved = ssFilterState[context][field];
    if (activeSaved) {
        currentOpenFilter.tempSelected = new Set(activeSaved);
    } else {
        currentOpenFilter.tempSelected = new Set(currentOpenFilter.distinctValues.map(d => d.val));
    }

    document.getElementById('ssf-popover-title').innerText = title;
    let sInp = document.getElementById('ssf-search-input');
    if (sInp) sInp.value = "";

    renderHeaderCheckboxList();

    let target = event.currentTarget || event.target;
    let rect = target.getBoundingClientRect();
    let left = Math.min(rect.left, window.innerWidth - 250);
    let top = rect.bottom + 6;

    popover.style.left = Math.max(10, left) + 'px';
    popover.style.top = top + 'px';
    popover.classList.remove('hidden');
}

function renderHeaderCheckboxList() {
    let listEl = document.getElementById('ssf-checkbox-list');
    if (!listEl) return;

    let searchTxt = (document.getElementById('ssf-search-input')?.value || '').toLowerCase();
    let items = currentOpenFilter.distinctValues;

    if (searchTxt) {
        items = items.filter(i => i.label.toLowerCase().includes(searchTxt) || i.val.toLowerCase().includes(searchTxt));
    }

    if (items.length === 0) {
        listEl.innerHTML = `<div style="padding:10px; text-align:center; color:#94a3b8; font-style:italic;">Tidak ada data.</div>`;
        return;
    }

    let html = "";
    items.forEach(item => {
        let isChecked = currentOpenFilter.tempSelected.has(item.val);
        html += `
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:11px; padding:3px 2px; color:#1e293b;">
                <input type="checkbox" value="${escapeHtmlKP(item.val)}" ${isChecked ? 'checked' : ''} onchange="onToggleHeaderItem('${escapeHtmlKP(item.val)}', this.checked)">
                <span style="flex:1;">${escapeHtmlKP(item.label)}</span>
                <span style="font-size:10px; color:#94a3b8; background:#f1f5f9; padding:1px 5px; border-radius:10px;">${item.count}</span>
            </label>
        `;
    });

    listEl.innerHTML = html;
}

function filterHeaderCheckboxList() {
    renderHeaderCheckboxList();
}

function onToggleHeaderItem(val, checked) {
    if (checked) {
        currentOpenFilter.tempSelected.add(val);
    } else {
        currentOpenFilter.tempSelected.delete(val);
    }
}

function selectAllHeaderFilter(selectAll) {
    if (selectAll) {
        currentOpenFilter.distinctValues.forEach(i => currentOpenFilter.tempSelected.add(i.val));
    } else {
        currentOpenFilter.tempSelected.clear();
    }
    renderHeaderCheckboxList();
}

function applyHeaderFilter() {
    let { context, field, distinctValues, tempSelected } = currentOpenFilter;
    if (!context || !field) return;

    if (tempSelected.size === distinctValues.length) {
        ssFilterState[context][field] = null;
    } else {
        ssFilterState[context][field] = new Set(tempSelected);
    }

    updateHeaderFilterIcons(context, field);
    closeHeaderFilter();

    if (context === 'mentah') {
        renderDataMentah();
    } else if (context === 'outflow' || context === 'inflow') {
        renderTrackingHPP();
    } else if (context === 'jurnal') {
        renderJurnal(jurnalDataGlobal);
    }
}

function closeHeaderFilter() {
    document.getElementById('spreadsheet-filter-popover')?.classList.add('hidden');
    currentOpenFilter.context = null;
    currentOpenFilter.field = null;
}

function updateHeaderFilterIcons(context, field) {
    let iconEl = document.getElementById(`filter-icon-${context}-${field}`);
    if (!iconEl) return;

    let isActive = ssFilterState[context][field] !== null;
    if (isActive) {
        iconEl.style.color = "#0284c7";
        iconEl.style.fontWeight = "bold";
    } else {
        iconEl.style.color = "#cbd5e1";
        iconEl.style.fontWeight = "normal";
    }
}

document.addEventListener('click', function(e) {
    let popover = document.getElementById('spreadsheet-filter-popover');
    if (popover && !popover.classList.contains('hidden')) {
        if (!popover.contains(e.target) && !e.target.closest('[onclick*="toggleHeaderFilter"]')) {
            closeHeaderFilter();
        }
    }
});

function renderDataMentah() {
    let tbody = document.getElementById('mentah-tbody');
    if (!tbody) return;

    let fSearch = (document.getElementById('mentah-search')?.value || '').toLowerCase();
    let filtered = dataMentahGlobal || [];

    // Terapkan Filter Kolom Header (Spreadsheet Style)
    if (ssFilterState.mentah.kategori) {
        filtered = filtered.filter(d => ssFilterState.mentah.kategori.has(d.kategori));
    }
    if (ssFilterState.mentah.cabang) {
        filtered = filtered.filter(d => ssFilterState.mentah.cabang.has(d.cabang));
    }
    if (ssFilterState.mentah.audit) {
        filtered = filtered.filter(d => ssFilterState.mentah.audit.has(d.audit ? d.audit.code : 'VALID'));
    }

    if (fSearch) {
        filtered = filtered.filter(d => 
            (d.relasi && d.relasi.toLowerCase().includes(fSearch)) ||
            (d.pakan && d.pakan.toLowerCase().includes(fSearch)) ||
            (d.catatan && d.catatan.toLowerCase().includes(fSearch)) ||
            (d.cabang && d.cabang.toLowerCase().includes(fSearch))
        );
    }

    // Update KPI
    let totalNilai = filtered.reduce((acc, cur) => acc + cur.total_nilai, 0);
    let totalHpp = filtered.reduce((acc, cur) => acc + cur.total_hpp, 0);
    let totalAnomali = filtered.filter(d => d.audit.status === 'ANOMALI').length;

    let nf = new Intl.NumberFormat('id-ID');
    let kpiRow = document.getElementById('mentah-kpi-total-row');
    if (kpiRow) kpiRow.innerText = nf.format(filtered.length);
    let kpiNilai = document.getElementById('mentah-kpi-total-nilai');
    if (kpiNilai) kpiNilai.innerText = 'Rp ' + nf.format(totalNilai);
    let kpiHpp = document.getElementById('mentah-kpi-total-hpp');
    if (kpiHpp) kpiHpp.innerText = 'Rp ' + nf.format(totalHpp);
    let kpiAnomali = document.getElementById('mentah-kpi-total-anomali');
    if (kpiAnomali) kpiAnomali.innerText = nf.format(totalAnomali) + ' Baris';

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:30px; color:#64748b;">Tidak ada data yang sesuai filter.</td></tr>`;
        return;
    }

    let mapKat = {
        'JUAL': { label: 'Penjualan', bg: '#e0f2fe', color: '#0369a1' },
        'PAKAI': { label: 'Pemakaian', bg: '#fef3c7', color: '#b45309' },
        'MUTASI': { label: 'Mutasi', bg: '#f3e8ff', color: '#7e22ce' },
        'MASUK': { label: 'Barang Masuk', bg: '#dcfce7', color: '#15803d' },
        'KAS': { label: 'Kas & Bank', bg: '#e2e8f0', color: '#334155' }
    };

    let html = "";
    filtered.forEach((r, idx) => {
        let tglStr = r.tanggal ? r.tanggal.split('-').reverse().join('/') : '-';
        let katObj = mapKat[r.kategori] || { label: r.kategori, bg: '#f1f5f9', color: '#334155' };
        let bgRow = idx % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";

        let pakanDisplay = escapeHtmlKP(r.pakan);
        let catatanDisplay = "";
        if (r.catatan) {
            let catText = escapeHtmlKP(r.catatan);
            let formattedCat = catText.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#0284c7; text-decoration:underline; font-weight:600;">[Lihat Foto SJ]</a>');
            catatanDisplay = `<div style="font-size:10px; color:#64748b; margin-top:2px; word-break:break-word; line-height:1.2;">${formattedCat}</div>`;
        }

        html += `<tr style="${bgRow}">
            <td style="padding:8px; text-align:center;">${tglStr}</td>
            <td style="padding:8px; text-align:center;">
                <span style="background:${katObj.bg}; color:${katObj.color}; padding:2px 8px; border-radius:4px; font-weight:700; font-size:10px;">${katObj.label}</span>
            </td>
            <td style="padding:8px; text-align:center; font-size:11px;">${r.cabang}</td>
            <td style="padding:8px; font-weight:600; color:#1e293b;">${escapeHtmlKP(r.relasi)}</td>
            <td style="padding:8px; line-height:1.3; max-width:240px; word-break:break-word;">
                <div style="font-weight:500;">${pakanDisplay}</div>
                ${catatanDisplay}
            </td>
            <td style="padding:8px; text-align:right;">${r.qty > 0 ? nf.format(r.qty) + ' ' + r.satuan : '-'}</td>
            <td style="padding:8px; text-align:right;">${r.harga_satuan > 0 ? nf.format(r.harga_satuan) : '-'}</td>
            <td style="padding:8px; text-align:right; font-weight:600;">${r.total_nilai > 0 ? nf.format(r.total_nilai) : '-'}</td>
            <td style="padding:8px; text-align:right; color:#c2410c;">${r.total_hpp > 0 ? nf.format(r.total_hpp) : '-'}</td>
            <td style="padding:8px; text-align:center;">
                <span title="${r.audit.pesan}" style="background:${r.audit.badgeBg}; color:${r.audit.badgeColor}; padding:2px 8px; border-radius:12px; font-weight:700; font-size:10px; display:inline-block; border:1px solid ${r.audit.badgeColor}33;">
                    ${r.audit.label}
                </span>
            </td>
            <td style="padding:8px; text-align:center;">
                <button onclick="bukaModalKoreksiMentah(${r.id}, '${r.source}')" title="Koreksi Transaksi" style="background:#0284c7; color:white; border:none; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:12px; display:inline-flex; align-items:center; gap:2px;">
                    <span class="material-symbols-outlined" style="font-size:14px;">edit</span>
                </button>
            </td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

function bukaModalKoreksiMentah(id, source) {
    let row = dataMentahGlobal.find(d => d.id === id && d.source === source);
    if (!row) {
        alert("Data transaksi tidak ditemukan!");
        return;
    }

    mentahEditingRow = row;

    document.getElementById('edit-mentah-id').value = row.id;
    document.getElementById('edit-mentah-source').value = row.source;
    document.getElementById('edit-mentah-tanggal').value = row.tanggal;
    document.getElementById('edit-mentah-cabang').value = row.cabang;
    document.getElementById('edit-mentah-status').value = row.kategori;
    document.getElementById('edit-mentah-relasi').value = row.relasi;
    document.getElementById('edit-mentah-pakan').value = row.pakan;
    document.getElementById('edit-mentah-qty').value = row.qty;
    document.getElementById('edit-mentah-satuan').value = row.satuan;
    document.getElementById('edit-mentah-harga').value = row.harga_satuan;
    document.getElementById('edit-mentah-nominal').value = row.total_nilai;
    document.getElementById('edit-mentah-catatan').value = row.catatan;

    let grpPakan = document.getElementById('group-edit-pakan');
    let grpQty = document.getElementById('group-edit-qty');
    let grpNom = document.getElementById('group-edit-nominal');

    if (source === 'cashflow') {
        if (grpPakan) grpPakan.style.display = 'none';
        if (grpQty) grpQty.style.display = 'none';
        if (grpNom) grpNom.style.display = 'block';
    } else {
        if (grpPakan) grpPakan.style.display = 'block';
        if (grpQty) grpQty.style.display = 'flex';
        if (grpNom) grpNom.style.display = 'none';
    }

    document.getElementById('modal-koreksi-data-mentah')?.classList.remove('hidden');
}

function tutupModalKoreksiMentah() {
    document.getElementById('modal-koreksi-data-mentah')?.classList.add('hidden');
    mentahEditingRow = null;
}

async function simpanKoreksiMentah() {
    if (!mentahEditingRow) return;

    let id = mentahEditingRow.id;
    let source = mentahEditingRow.source;
    let btnSimpan = document.getElementById('btn-simpan-koreksi-mentah');

    let tgl = document.getElementById('edit-mentah-tanggal').value;
    let cab = document.getElementById('edit-mentah-cabang').value.trim();
    let rel = document.getElementById('edit-mentah-relasi').value.trim();
    let pkn = document.getElementById('edit-mentah-pakan').value.trim();
    let qty = parseFloat(document.getElementById('edit-mentah-qty').value) || 0;
    let sat = document.getElementById('edit-mentah-satuan').value.trim();
    let hs = parseFloat(document.getElementById('edit-mentah-harga').value) || 0;
    let nom = parseFloat(document.getElementById('edit-mentah-nominal').value) || 0;
    let cat = document.getElementById('edit-mentah-catatan').value.trim();

    if (!rel) {
        alert("Nama Relasi / Peternak tidak boleh kosong!");
        return;
    }

    if (btnSimpan) {
        btnSimpan.disabled = true;
        btnSimpan.innerText = "Menyimpan...";
    }

    try {
        let payload = {};
        if (source === 'transaksi_pakan') {
            payload = {
                tanggal: tgl,
                cabang: cab,
                relasi: rel,
                pakan: pkn,
                qty: qty,
                satuan: sat,
                harga_satuan: hs,
                catatan: cat + (cat.includes('[Diedit Admin 2]') ? '' : ' [Diedit Admin 2]')
            };
        } else {
            payload = {
                tanggal: tgl,
                relasi: rel,
                nominal: nom,
                keterangan: cat + (cat.includes('[Diedit Admin 2]') ? '' : ' [Diedit Admin 2]')
            };
        }

        let res = await fetch(`${SUPA_URL}/rest/v1/${source}?id=eq.${id}`, {
            method: 'PATCH',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            let errText = await res.text();
            throw new Error(errText);
        }

        // Update local object
        mentahEditingRow.tanggal = tgl;
        mentahEditingRow.cabang = cab;
        mentahEditingRow.relasi = rel;
        mentahEditingRow.pakan = pkn;
        mentahEditingRow.qty = qty;
        mentahEditingRow.satuan = sat;
        mentahEditingRow.harga_satuan = hs;
        mentahEditingRow.total_nilai = source === 'transaksi_pakan' ? (qty * hs) : nom;
        mentahEditingRow.catatan = payload.catatan || cat;

        tutupModalKoreksiMentah();
        renderDataMentah();
        alert(`Sukses mengoreksi transaksi #${id}! Perubahan langsung tersinkron ke Supabase.`);
    } catch (err) {
        console.error("Gagal simpan koreksi:", err);
        alert("Gagal menyimpan koreksi: " + err.message);
    } finally {
        if (btnSimpan) {
            btnSimpan.disabled = false;
            btnSimpan.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; margin-right:4px;">save</span> Simpan Perubahan`;
        }
    }
}

function toggleDropdownExportMentah(e) {
    if (e) e.stopPropagation();
    let dd = document.getElementById('dropdown-export-mentah');
    dd?.classList.toggle('hidden');
}

function exportDataMentah(fmt) {
    document.getElementById('dropdown-export-mentah')?.classList.add('hidden');
    if (!dataMentahGlobal || dataMentahGlobal.length === 0) {
        alert("Tidak ada data mentah untuk diexport!");
        return;
    }

    let rows = dataMentahGlobal.map(r => ({
        'Tanggal': r.tanggal,
        'Kategori': r.kategori,
        'Cabang': r.cabang,
        'Relasi': r.relasi,
        'Pakan/Uraian': r.pakan,
        'Qty': r.qty,
        'Satuan': r.satuan,
        'Harga Satuan': r.harga_satuan,
        'Total Nilai': r.total_nilai,
        'Total HPP': r.total_hpp,
        'Status Audit': r.audit.label,
        'Catatan': r.catatan
    }));

    let bulan = document.getElementById('mentah-bulan')?.value || 'Semua';
    let tahun = document.getElementById('mentah-tahun')?.value || new Date().getFullYear();
    let filename = `Data_Mentah_CBL_${bulan}_${tahun}`;

    if (fmt === 'xlsx' && typeof XLSX !== 'undefined') {
        let wb = XLSX.utils.book_new();
        let ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, "Data Mentah");
        XLSX.writeFile(wb, `${filename}.xlsx`);
    } else {
        let csvHeader = Object.keys(rows[0]).join(";");
        let csvBody = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
        let csv = "\uFEFFsep=;\r\n" + csvHeader + "\r\n" + csvBody;
        let blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${filename}.csv`;
        a.click();
    }
}


// =========================================================================
// SUB-MENU 2: TRACKING HPP & STOK BATCH
// =========================================================================

let hppOutflowGlobal = [];
let hppInflowGlobal = [];
let hppCurrentSubTab = 'outflow';

// Helper 4 Status Batch Gudang: Utuh, Aktif, Kritis, Habis
function getBatchStatus(b) {
    let qtyAwal = Number(b.qty_awal) || 0;
    let qtySisa = Number(b.qty_sisa) || 0;
    let pctSisa = qtyAwal > 0 ? Math.round((qtySisa / qtyAwal) * 100) : 0;

    if (qtySisa <= 0) {
        return { code: 'HABIS', label: 'Habis', bg: '#f1f5f9', color: '#94a3b8' };
    }
    if (qtySisa >= qtyAwal) {
        return { code: 'UTUH', label: 'Utuh', bg: '#e0f2fe', color: '#0369a1' };
    }
    if (pctSisa <= 15) {
        return { code: 'KRITIS', label: 'Kritis', bg: '#fef3c7', color: '#b45309' };
    }
    return { code: 'AKTIF', label: 'Aktif', bg: '#dcfce7', color: '#15803d' };
}

// Pagination State Kartu Batch Gudang
let hppBatchCurrentPage = 1;
const hppBatchPageSize = 50;

function changePageBatch(newPage) {
    hppBatchCurrentPage = newPage;
    renderTrackingInflow();
}

function initTanggalHPP() {
    let selBulan = document.getElementById('hpp-bulan');
    let selTahun = document.getElementById('hpp-tahun');
    if (selBulan && (!selBulan.value || selBulan.value === 'ALL')) {
        let now = new Date();
        selBulan.value = ("0" + (now.getMonth() + 1)).slice(-2);
        if (selTahun) selTahun.value = now.getFullYear();
    }
}

function switchSubTabHPP(subtab) {
    hppCurrentSubTab = subtab;
    let btnOut = document.getElementById('subtab-hpp-outflow');
    let btnIn = document.getElementById('subtab-hpp-inflow');
    let contOut = document.getElementById('container-hpp-outflow');
    let contIn = document.getElementById('container-hpp-inflow');

    if (subtab === 'outflow') {
        if (btnOut) btnOut.style.background = '#8AA624';
        if (btnIn) btnIn.style.background = '#64748b';
        contOut?.classList.remove('hidden');
        contIn?.classList.add('hidden');
        document.getElementById('hpp-kpi-label-1').innerText = "Total Pakan Keluar";
        document.getElementById('hpp-kpi-label-2').innerText = "Total Nilai HPP";
        document.getElementById('hpp-kpi-label-3').innerText = "Rata-rata HPP/Kg";
        document.getElementById('hpp-kpi-label-4').innerText = "Status Stok FIFO";
    } else {
        if (btnIn) btnIn.style.background = '#8AA624';
        if (btnOut) btnOut.style.background = '#64748b';
        contIn?.classList.remove('hidden');
        contOut?.classList.add('hidden');
        document.getElementById('hpp-kpi-label-1').innerText = "Total Batch Aktif";
        document.getElementById('hpp-kpi-label-2').innerText = "Total Nilai Aset Sisa";
        document.getElementById('hpp-kpi-label-3').innerText = "Total Sisa Stok Fisik";
        document.getElementById('hpp-kpi-label-4').innerText = "Kesehatan Umur Batch";
    }
    renderTrackingHPP();
}

async function fetchTrackingHPP() {
    let loader = document.getElementById('hpp-loader');
    loader?.classList.remove('hidden');
    hppBatchCurrentPage = 1;

    try {
        let bulan = document.getElementById('hpp-bulan')?.value || 'ALL';
        let tahun = document.getElementById('hpp-tahun')?.value || new Date().getFullYear();

        let startDate = `${tahun}-01-01`;
        let endDate = `${tahun}-12-31`;
        if (bulan && bulan !== 'ALL') {
            let lastDay = new Date(tahun, Number(bulan), 0).getDate();
            startDate = `${tahun}-${bulan}-01`;
            endDate = `${tahun}-${bulan}-${("0" + lastDay).slice(-2)}`;
        }

        let headers = {
            'apikey': SUPA_ANON_KEY,
            'Authorization': `Bearer ${SUPA_ANON_KEY}`
        };

        // Batch query: order descending (tanggal_masuk.desc, id.desc) with limit 3000
        // agar batch terbaru (2026) selalu termuat lebih dulu
        let batchQuery = `${SUPA_URL}/rest/v1/stok_batch?order=tanggal_masuk.desc,id.desc&limit=3000`;

        let [resOutflow, resInflow] = await Promise.all([
            fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=gte.${startDate}&tanggal=lte.${endDate}&status=ilike.*keluar*&order=tanggal.desc,id.desc`, { headers }),
            fetch(batchQuery, { headers })
        ]);

        let rawOut = resOutflow.ok ? await resOutflow.json() : [];
        let rawIn = resInflow.ok ? await resInflow.json() : [];

        // Filter non-bapera
        hppOutflowGlobal = rawOut.filter(r => !(r.relasi || '').toLowerCase().includes('bapera'));
        hppInflowGlobal = rawIn;

        renderTrackingHPP();
    } catch (err) {
        console.error("Gagal memuat data tracking HPP:", err);
        alert("Gagal memuat data tracking HPP: " + err.message);
    } finally {
        loader?.classList.add('hidden');
    }
}

function onStatusBatchChange() {
    fetchTrackingHPP();
}

function renderTrackingHPP() {
    if (hppCurrentSubTab === 'outflow') {
        renderTrackingOutflow();
    } else {
        renderTrackingInflow();
    }
}

function renderTrackingOutflow() {
    let tbody = document.getElementById('hpp-outflow-tbody');
    if (!tbody) return;

    let fSearch = (document.getElementById('hpp-search')?.value || '').toLowerCase();

    let filtered = hppOutflowGlobal || [];

    // Spreadsheet column filter (Cabang & Status FIFO)
    if (ssFilterState.outflow.cabang) {
        filtered = filtered.filter(d => ssFilterState.outflow.cabang.has(d.cabang || '-'));
    }
    if (ssFilterState.outflow.status) {
        filtered = filtered.filter(d => {
            let isOngkir = (d.pakan || '').toLowerCase().includes('ongkir');
            let st = isOngkir ? 'Non-Stok' : (Number(d.total_hpp) > 0 ? 'Ter-Cover' : 'Defisit');
            return ssFilterState.outflow.status.has(st);
        });
    }

    if (fSearch) {
        filtered = filtered.filter(d => 
            (d.pakan && d.pakan.toLowerCase().includes(fSearch)) ||
            (d.relasi && d.relasi.toLowerCase().includes(fSearch)) ||
            (d.cabang && d.cabang.toLowerCase().includes(fSearch))
        );
    }

    let nf = new Intl.NumberFormat('id-ID');
    let totalKg = 0;
    let totalHpp = 0;
    let countDefisit = 0;
    let countEstimasi = 0;

    filtered.forEach(c => {
        let isOng = (c.pakan || '').toLowerCase().includes('ongkir');
        let q = Number(c.qty) || 0;
        let rawH = Number(c.total_hpp) || 0;
        let h = rawH;
        totalKg += q;
        if (!isOng) {
            if (rawH > 0) {
                h = getEffectiveHppWithGiling(rawH, q, c.pakan, 0, Number(c.harga_satuan) || 0).totalHpp;
            } else if (q > 0) {
                let match = (hppInflowGlobal || []).find(b => b.pakan === c.pakan && Number(b.hpp) > 0);
                if (match) {
                    h = getEffectiveHppWithGiling(0, q, c.pakan, Math.round(Number(match.hpp)), 0).totalHpp;
                    countEstimasi++;
                } else {
                    countDefisit++;
                }
            }
        }
        totalHpp += h;
    });

    let avgHpp = totalKg > 0 ? Math.round(totalHpp / totalKg) : 0;

    document.getElementById('hpp-kpi-val-1').innerText = nf.format(totalKg) + ' Kg';
    document.getElementById('hpp-kpi-val-2').innerText = 'Rp ' + nf.format(totalHpp);
    document.getElementById('hpp-kpi-val-3').innerText = 'Rp ' + nf.format(avgHpp) + ' / Kg';
    if (countDefisit > 0) {
        document.getElementById('hpp-kpi-val-4').innerHTML = `<span style="color:#dc2626; font-weight:bold;">${countDefisit} Tx Defisit</span>`;
    } else if (countEstimasi > 0) {
        document.getElementById('hpp-kpi-val-4').innerHTML = `<span style="color:#2563eb; font-weight:bold;">${countEstimasi} Tx Estimasi Sementara</span>`;
    } else {
        document.getElementById('hpp-kpi-val-4').innerHTML = `<span style="color:#15803d; font-weight:bold;">Normal</span>`;
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:30px; color:#64748b;">Tidak ada data pengeluaran HPP yang sesuai filter.</td></tr>`;
        return;
    }

    let html = "";
    filtered.forEach((r, idx) => {
        let tglStr = r.tanggal ? r.tanggal.split('-').reverse().join('/') : '-';
        let qty = Number(r.qty) || 0;
        let hs = Number(r.harga_satuan) || 0;
        let rawHpp = Number(r.total_hpp) || 0;
        let hpp = rawHpp;
        let unitHpp = qty > 0 && hpp > 0 ? Math.round(hpp / qty) : 0;
        let isOngkir = (r.pakan || '').toLowerCase().includes('ongkir');
        let isEstimasiHpp = false;

        // 🚨 Fallback HPP jika HPP masih 0 + Kapitalisasi Upah Giling (+Rp 100/Kg utk RD/RL)
        if (!isOngkir && qty > 0) {
            let matchedInflow = (hppInflowGlobal || []).find(b => b.pakan === r.pakan && Number(b.hpp) > 0);
            let fallbackUnit = matchedInflow ? Math.round(Number(matchedInflow.hpp)) : 0;
            let eff = getEffectiveHppWithGiling(rawHpp, qty, r.pakan, fallbackUnit, hs);
            hpp = eff.totalHpp;
            unitHpp = eff.unitHpp;
            isEstimasiHpp = eff.isEstimasi;
        }

        let margin = hs > 0 && unitHpp > 0 ? (hs - unitHpp) : 0;
        let marginPct = hs > 0 && margin > 0 ? ((margin / hs) * 100).toFixed(1) + '%' : '-';

        // Silsilah Batch
        let matchedBatch = (hppInflowGlobal || []).find(b => b.pakan === r.pakan && (b.cabang === r.cabang || !b.cabang));
        let silsilahText = "";
        if (isOngkir) {
            silsilahText = `<span style="color:#64748b; font-style:italic;">Bukan stok fisik (Jasa Ongkir)</span>`;
        } else if (isEstimasiHpp) {
            silsilahText = `<span style="color:#2563eb; font-weight:600;">• Estimasi Terakhir @${nf.format(unitHpp)}<br/><span style="font-size:10px; color:#3b82f6; font-style:italic;">(Menunggu input HPP)</span></span>`;
        } else if (unitHpp > 0 && matchedBatch) {
            let batchRawHpp = Math.round(Number(matchedBatch.hpp || 0));
            let batchDispHpp = isPakanGilingJadi(r.pakan) ? (batchRawHpp > 0 ? batchRawHpp + 100 : unitHpp) : (matchedBatch.hpp || unitHpp);
            silsilahText = `• Batch #${matchedBatch.id} (${matchedBatch.tanggal_masuk}) @${nf.format(batchDispHpp)}${isPakanGilingJadi(r.pakan) ? ' <span style="font-size:10px;color:#0f766e;">(+Giling 100)</span>' : ''}`;
        } else if (unitHpp > 0) {
            silsilahText = `• FIFO Stok Masuk @${nf.format(unitHpp)}${isPakanGilingJadi(r.pakan) ? ' <span style="font-size:10px;color:#0f766e;">(+Giling 100)</span>' : ''}`;
        } else {
            silsilahText = `<span style="color:#dc2626; font-weight:bold;">Tidak ada batch aktif (Stok defisit)</span>`;
        }

        let statusBadge = "";
        if (isOngkir) {
            statusBadge = `<span style="background:#e2e8f0; color:#475569; padding:2px 8px; border-radius:10px; font-weight:bold; font-size:10px;">Non-Stok</span>`;
        } else if (isEstimasiHpp) {
            statusBadge = `<span style="background:#dbeafe; color:#1d4ed8; padding:2px 8px; border-radius:10px; font-weight:bold; font-size:10px; border:1px solid #bfdbfe;" title="HPP Sementara (Estimasi) - Menunggu input HPP">Estimasi Sementara</span>`;
        } else if (hpp > 0) {
            statusBadge = `<span style="background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:10px; font-weight:bold; font-size:10px;">Ter-Cover</span>`;
        } else {
            statusBadge = `<span style="background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:10px; font-weight:bold; font-size:10px;">Defisit</span>`;
        }

        let bgRow = idx % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";

        html += `<tr style="${bgRow}">
            <td style="padding:8px; text-align:center;">${tglStr}</td>
            <td style="padding:8px; text-align:center; font-size:11px;">${r.cabang || '-'}</td>
            <td style="padding:8px; font-weight:600;">${escapeHtmlKP(r.relasi || '-')}</td>
            <td style="padding:8px;">${escapeHtmlKP(r.pakan || '-')}</td>
            <td style="padding:8px; text-align:right; font-weight:bold;">${qty > 0 ? nf.format(qty) + ' ' + (r.satuan || 'Kg') : '-'}</td>
            <td style="padding:8px; font-size:11px; line-height:1.4;">${silsilahText}</td>
            <td style="padding:8px; text-align:right; font-weight:bold; color:${isEstimasiHpp ? '#2563eb' : (hpp > 0 ? '#c2410c' : '#dc2626')};" title="${isEstimasiHpp ? 'HPP Sementara (Estimasi) - Menunggu input HPP' : ''}">
                ${hpp > 0 ? 'Rp ' + nf.format(hpp) : 'Rp 0'}
                ${isEstimasiHpp ? '<span style="font-size:9px; background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; border-radius:3px; padding:0 3px; margin-left:3px; font-weight:normal;">Sementara</span>' : ''}
            </td>
            <td style="padding:8px; text-align:right; font-weight:${isEstimasiHpp ? 'bold' : 'normal'}; color:${isEstimasiHpp ? '#2563eb' : 'inherit'};">${unitHpp > 0 ? 'Rp ' + nf.format(unitHpp) : '-'}</td>
            <td style="padding:8px; text-align:right;">${hs > 0 ? 'Rp ' + nf.format(hs) : '-'}</td>
            <td style="padding:8px; text-align:right; color:${margin > 0 ? '#15803d' : '#64748b'}; font-weight:600;">
                ${margin > 0 ? '+' + nf.format(margin) + ` (${marginPct})` : '-'}
            </td>
            <td style="padding:8px; text-align:center;">${statusBadge}</td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

function renderTrackingInflow() {
    let tbody = document.getElementById('hpp-inflow-tbody');
    let paginEl = document.getElementById('hpp-inflow-pagination');
    if (!tbody) return;

    let fSearch = (document.getElementById('hpp-search')?.value || '').toLowerCase();

    let filtered = hppInflowGlobal || [];

    // Spreadsheet column filter (Cabang & Status Batch)
    if (ssFilterState.inflow.cabang) {
        filtered = filtered.filter(d => ssFilterState.inflow.cabang.has(d.cabang || '-'));
    }
    if (ssFilterState.inflow.status) {
        filtered = filtered.filter(b => {
            let stObj = getBatchStatus(b);
            return ssFilterState.inflow.status.has(stObj.code);
        });
    }

    if (fSearch) {
        filtered = filtered.filter(d => 
            (d.pakan && d.pakan.toLowerCase().includes(fSearch)) ||
            (d.cabang && d.cabang.toLowerCase().includes(fSearch)) ||
            (d.blok && d.blok.toLowerCase().includes(fSearch))
        );
    }

    let nf = new Intl.NumberFormat('id-ID');
    let batchAktif = filtered.filter(b => (Number(b.qty_sisa) || 0) > 0);
    let totalSisaKg = batchAktif.reduce((acc, b) => acc + (Number(b.qty_sisa) || 0), 0);
    let totalAsetSisa = batchAktif.reduce((acc, b) => {
        let qSisa = Number(b.qty_sisa) || 0;
        let hppEff = (Number(b.hpp) || 0) + (isPakanGilingJadi(b.pakan) ? 100 : 0);
        return acc + (qSisa * hppEff);
    }, 0);

    document.getElementById('hpp-kpi-val-1').innerText = nf.format(batchAktif.length) + ' Batch';
    document.getElementById('hpp-kpi-val-2').innerText = 'Rp ' + nf.format(totalAsetSisa);
    document.getElementById('hpp-kpi-val-3').innerText = nf.format(totalSisaKg) + ' Kg';
    document.getElementById('hpp-kpi-val-4').innerHTML = `<span style="color:#15803d; font-weight:bold;">FIFO Aktif</span>`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center; padding:30px; color:#64748b;">Tidak ada data batch stok yang sesuai filter.</td></tr>`;
        if (paginEl) paginEl.innerHTML = `<span style="color:#94a3b8;">0 batch</span>`;
        return;
    }

    // Pagination Calculation (50 baris per halaman)
    let totalRows = filtered.length;
    let totalPages = Math.ceil(totalRows / hppBatchPageSize) || 1;
    if (hppBatchCurrentPage < 1) hppBatchCurrentPage = 1;
    if (hppBatchCurrentPage > totalPages) hppBatchCurrentPage = totalPages;

    let startIdx = (hppBatchCurrentPage - 1) * hppBatchPageSize;
    let endIdx = Math.min(startIdx + hppBatchPageSize, totalRows);
    let pageRows = filtered.slice(startIdx, endIdx);

    let now = new Date();
    let html = "";
    pageRows.forEach((b, idx) => {
        let tglStr = b.tanggal_masuk ? b.tanggal_masuk.split('-').reverse().join('/') : '-';
        let qtyAwal = Number(b.qty_awal) || 0;
        let qtySisa = Number(b.qty_sisa) || 0;
        let qtyPakai = Math.max(0, qtyAwal - qtySisa);
        let isGilingJadi = isPakanGilingJadi(b.pakan);
        let hpp = (Number(b.hpp) || 0) + (isGilingJadi ? 100 : 0);
        let nilaiAset = qtySisa * hpp;

        let pctSisa = qtyAwal > 0 ? Math.round((qtySisa / qtyAwal) * 100) : 0;

        let umurHari = b.tanggal_masuk ? Math.floor((now - new Date(b.tanggal_masuk)) / (1000 * 60 * 60 * 24)) : 0;
        let umurColor = umurHari > 45 ? '#dc2626' : (umurHari > 25 ? '#d97706' : '#15803d');

        let stObj = getBatchStatus(b);
        let statusBatch = `<span style="background:${stObj.bg}; color:${stObj.color}; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:bold; border:1px solid ${stObj.color}33;">${stObj.label}</span>`;

        let bgRow = idx % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";

        html += `<tr style="${bgRow}">
            <td style="padding:8px; text-align:center; font-weight:bold; color:#0369a1;">#${b.id}</td>
            <td style="padding:8px; text-align:center;">${tglStr}</td>
            <td style="padding:8px; text-align:center; font-size:11px;">${escapeHtmlKP(b.cabang || '-')}${b.blok ? ' / ' + escapeHtmlKP(b.blok) : ''}</td>
            <td style="padding:8px; font-size:11px; color:#475569;">${b.transaksi_id ? 'Penerimaan #' + b.transaksi_id : 'Supplier Pakan'}</td>
            <td style="padding:8px; font-weight:600;">${escapeHtmlKP(b.pakan || '-')}</td>
            <td style="padding:8px; text-align:right;">Rp ${nf.format(hpp)}</td>
            <td style="padding:8px; text-align:right;">${nf.format(qtyAwal)} Kg</td>
            <td style="padding:8px; text-align:right; color:#64748b;">${nf.format(qtyPakai)} Kg</td>
            <td style="padding:8px; text-align:right; font-weight:bold; color:${qtySisa > 0 ? '#15803d' : '#94a3b8'};">${nf.format(qtySisa)} Kg</td>
            <td style="padding:8px; text-align:center;">
                <div style="background:#e2e8f0; border-radius:6px; height:12px; width:100%; overflow:hidden; position:relative;">
                    <div style="background:${pctSisa > 20 ? '#10b981' : '#f59e0b'}; width:${pctSisa}%; height:100%;"></div>
                </div>
                <div style="font-size:10px; color:#64748b; margin-top:2px;">${pctSisa}% Sisa</div>
            </td>
            <td style="padding:8px; text-align:right; font-weight:bold; color:#0369a1;">Rp ${nf.format(nilaiAset)}</td>
            <td style="padding:8px; text-align:center; font-weight:bold; color:${umurColor};">${umurHari} Hari</td>
            <td style="padding:8px; text-align:center;">${statusBatch}</td>
        </tr>`;
    });

    tbody.innerHTML = html;

    // Render Pagination Controls
    if (paginEl) {
        let isFirst = hppBatchCurrentPage <= 1;
        let isLast = hppBatchCurrentPage >= totalPages;

        paginEl.innerHTML = `
            <div style="color:#475569;">
                Menampilkan <b>${startIdx + 1} - ${endIdx}</b> dari <b>${nf.format(totalRows)}</b> batch
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <button onclick="changePageBatch(${hppBatchCurrentPage - 1})" ${isFirst ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : 'style="cursor:pointer;"'} class="btn-submit" style="margin:0; padding:4px 10px; font-size:11px; background:#e2e8f0; color:#334155;">
                    <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle;">chevron_left</span> Prev
                </button>
                <span style="padding:0 8px; font-weight:bold; color:#1e293b;">Hal ${hppBatchCurrentPage} / ${totalPages}</span>
                <button onclick="changePageBatch(${hppBatchCurrentPage + 1})" ${isLast ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : 'style="cursor:pointer;"'} class="btn-submit" style="margin:0; padding:4px 10px; font-size:11px; background:#e2e8f0; color:#334155;">
                    Next <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle;">chevron_right</span>
                </button>
            </div>
        `;
    }
}

function toggleDropdownExportHPP(e) {
    if (e) e.stopPropagation();
    let dd = document.getElementById('dropdown-export-hpp');
    dd?.classList.toggle('hidden');
}

function exportTrackingHPP(fmt) {
    document.getElementById('dropdown-export-hpp')?.classList.add('hidden');
    let bulan = document.getElementById('hpp-bulan')?.value || 'Semua';
    let tahun = document.getElementById('hpp-tahun')?.value || new Date().getFullYear();
    let filename = `Tracking_HPP_${hppCurrentSubTab}_${bulan}_${tahun}`;

    let rows = [];
    if (hppCurrentSubTab === 'outflow') {
        if (!hppOutflowGlobal || hppOutflowGlobal.length === 0) {
            alert("Tidak ada data outflow untuk diexport!");
            return;
        }
        rows = hppOutflowGlobal.map(r => ({
            'Tanggal': r.tanggal,
            'Cabang': r.cabang,
            'Relasi': r.relasi,
            'Pakan': r.pakan,
            'Qty Keluar': r.qty,
            'Satuan': r.satuan,
            'Harga Satuan Jual': r.harga_satuan,
            'Total HPP': r.total_hpp,
            'Catatan': r.catatan
        }));
    } else {
        if (!hppInflowGlobal || hppInflowGlobal.length === 0) {
            alert("Tidak ada data batch untuk diexport!");
            return;
        }
        rows = hppInflowGlobal.map(b => ({
            'ID Batch': b.id,
            'Tgl Masuk': b.tanggal_masuk,
            'Cabang': b.cabang,
            'Blok': b.blok || '-',
            'Pakan': b.pakan,
            'Harga Beli (HPP)': b.hpp,
            'Qty Awal': b.qty_awal,
            'Qty Sisa': b.qty_sisa
        }));
    }

    if (fmt === 'xlsx' && typeof XLSX !== 'undefined') {
        let wb = XLSX.utils.book_new();
        let ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, "Tracking HPP");
        XLSX.writeFile(wb, `${filename}.xlsx`);
    } else {
        let csvHeader = Object.keys(rows[0]).join(";");
        let csvBody = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
        let csv = "\uFEFFsep=;\r\n" + csvHeader + "\r\n" + csvBody;
        let blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${filename}.csv`;
        a.click();
    }
}


// =========================================================================
// SUB-MENU 3: LAPORAN LABA RUGI (INCOME STATEMENT)
// =========================================================================

let labaRugiDataGlobal = null;

function initTanggalLR() {
    let selBulan = document.getElementById('lr-bulan');
    let selTahun = document.getElementById('lr-tahun');
    if (selBulan && (!selBulan.value || selBulan.value === 'ALL')) {
        let now = new Date();
        selBulan.value = ("0" + (now.getMonth() + 1)).slice(-2);
        if (selTahun) selTahun.value = now.getFullYear();
    }
}

async function muatLabaRugi() {
    let loader = document.getElementById('lr-loader');
    loader?.classList.remove('hidden');

    try {
        let bulan = document.getElementById('lr-bulan')?.value || 'ALL';
        let tahun = document.getElementById('lr-tahun')?.value || new Date().getFullYear();

        let startDate = `${tahun}-01-01`;
        let endDate = `${tahun}-12-31`;
        let periodeLabel = `Tahun ${tahun}`;
        if (bulan && bulan !== 'ALL') {
            let lastDay = new Date(tahun, Number(bulan), 0).getDate();
            startDate = `${tahun}-${bulan}-01`;
            endDate = `${tahun}-${bulan}-${("0" + lastDay).slice(-2)}`;
            let namaBulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"][Number(bulan) - 1];
            periodeLabel = `${namaBulan} ${tahun}`;
        }

        let headers = {
            'apikey': SUPA_ANON_KEY,
            'Authorization': `Bearer ${SUPA_ANON_KEY}`
        };

        // Fetch view_jurnal_umum, transaksi_pakan (keluar), cashflow (keluar), dan stok_batch secara paralel (bebas limit 1.000 baris)
        let [jData, trxData, cfData, batchData] = await Promise.all([
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/view_jurnal_umum?tanggal=gte.${startDate}&tanggal=lte.${endDate}&select=tanggal,kode_akun,nama_akun,relasi,deskripsi,debit,kredit&order=tanggal.asc,id_jurnal.asc`, headers),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=gte.${startDate}&tanggal=lte.${endDate}&status=ilike.*keluar*&select=id,tanggal,cabang,status,relasi,pakan,qty,satuan,harga_satuan,total_hpp,catatan,hash_str&order=tanggal.asc,id.asc`, headers),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/cashflow?tanggal=gte.${startDate}&tanggal=lte.${endDate}&jenis=ilike.*keluar*&select=tanggal,relasi,kategori,keterangan,nominal&order=tanggal.asc,id.asc`, headers),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/stok_batch?order=tanggal_masuk.desc,id.desc&limit=1500&select=pakan,hpp`, headers)
        ]);

        // Build fallback HPP map dari batch terbaru di gudang
        let fallbackHppMap = {};
        batchData.forEach(b => {
            let pkn = (b.pakan || '').trim();
            let unitHpp = Number(b.hpp) || 0;
            if (unitHpp > 0 && pkn && !fallbackHppMap[pkn]) {
                fallbackHppMap[pkn] = unitHpp;
            }
        });

        // 1. Ambil data diskon & retur dari jurnal
        let revDiskon = 0;
        let revRetur = 0;
        jData.forEach(d => {
            let deb = Number(d.debit) || 0;
            let nama = (d.nama_akun || '').trim();
            if (nama === 'Biaya Diskon & Lain-lain') {
                revDiskon += deb;
            } else if (nama === 'Retur Penjualan') {
                revRetur += deb;
            }
        });

        // 2. Pemisahan Penjualan Pakan Komersial, Jasa Ongkir, dan Pemakaian Internal Kandang
        let revPenjualanPakan = 0;
        let revJasaOngkir = 0;
        let cogsPakanKomersial = 0;
        let cogsHasEstimasi = false;
        let countHppSementara = 0;
        let countHppSementaraKomersial = 0;
        let countHppSementaraInternal = 0;

        // Price lookup dari transaksi komersial untuk menghitung harga jual normal bagi pemakaian kandang
        let priceLookup = {};
        trxData.forEach(t => {
            let pkn = (t.pakan || '').trim();
            let hs = Number(t.harga_satuan) || 0;
            if (hs > 0 && pkn && !priceLookup[pkn]) {
                priceLookup[pkn] = hs;
            }
        });

        // Helper bersama untuk saring logistik transfer, bahan baku gilingan SPN, dan klasifikasi konsumsi ternak internal
        let isLogistikTransferRow = isLogistikTransferShared;
        let isBahanBakuGilinganRow = isBahanBakuGilinganShared;
        let getKonsumsiTernakInfo = classifyKonsumsiTernakBranch;

        let pemakaianKandangDetail = {};
        let pemakaianKandangPerCabang = {
            'PM': { key: 'PM', label: 'KANDANG PM (Pembibitan Manoko)', items: {}, totalQty: 0, totalHpp: 0, totalJual: 0 },
            'RPH': { key: 'RPH', label: 'KANDANG RPH (Penggemukan & Potong)', items: {}, totalQty: 0, totalHpp: 0, totalJual: 0 },
            'SPN': { key: 'SPN', label: 'KANDANG SPN (Sapi Perah)', items: {}, totalQty: 0, totalHpp: 0, totalJual: 0 }
        };

        trxData.forEach(t => {
            let rel = (t.relasi || '').trim();
            if (rel.toLowerCase().includes('bapera')) return;

            // Saring A: Logistik drop pakan / transfer antar-gudang (JANGAN MASUK LABA RUGI)
            if (isLogistikTransferRow(t)) return;

            // Saring B: Bahan baku gilingan SPN (JANGAN MASUK PENJUALAN KOMERSIAL)
            if (isBahanBakuGilinganRow(t)) return;

            let pkn = (t.pakan || '').trim();
            let isOngkir = pkn.toLowerCase().includes('ongkir');
            let qty = Number(t.qty) || 0;
            let hs = Number(t.harga_satuan) || 0;
            let rawHpp = Number(t.total_hpp) || 0;
            let totalNilai = qty * hs;

            // 🚨 PENANGANAN STOK DEFISIT / HPP 0 + KAPITALISASI UPAH GILING (+Rp 100/Kg utk RD/RL)
            let fallbackUnit = fallbackHppMap[pkn] || 0;
            let effHpp = isOngkir
                ? { totalHpp: rawHpp, unitHpp: 0, isEstimasi: false, hasGilingCost: false }
                : getEffectiveHppWithGiling(rawHpp, qty, pkn, fallbackUnit, hs);
            let hpp = effHpp.totalHpp;
            let isHppSementara = effHpp.isEstimasi;
            if (isHppSementara) countHppSementara++;
            t._isHppSementara = isHppSementara;
            t._effectiveHpp = hpp;

            let ternakInfo = getKonsumsiTernakInfo(t);

            if (ternakInfo) {
                if (isHppSementara) countHppSementaraInternal++;
                // Alokasi Konsumsi Pakan Ternak Sendiri (Holding Internal)
                let { cabangKey, unit } = ternakInfo;
                let targetBranch = pemakaianKandangPerCabang[cabangKey] || pemakaianKandangPerCabang['PM'];

                if (!targetBranch.items[unit]) {
                    targetBranch.items[unit] = {
                        unit: unit,
                        totalQty: 0,
                        totalHpp: 0,
                        totalJual: 0,
                        hasEstimasi: false
                    };
                }
                targetBranch.items[unit].totalQty += qty;
                targetBranch.items[unit].totalHpp += hpp;
                if (isHppSementara) targetBranch.items[unit].hasEstimasi = true;

                // Flat detail (backward compatibility)
                if (!pemakaianKandangDetail[unit]) {
                    pemakaianKandangDetail[unit] = { unit: unit, totalQty: 0, totalHpp: 0, totalJual: 0, hasEstimasi: false };
                }
                pemakaianKandangDetail[unit].totalQty += qty;
                pemakaianKandangDetail[unit].totalHpp += hpp;
                if (isHppSementara) pemakaianKandangDetail[unit].hasEstimasi = true;

                // 🚨 KOREKSI NILAI JUAL NORMAL PASAR INTERNAL:
                // Pastikan harga acuan jual tidak lebih murah dari HPP modal produksinya sendiri
                let unitHpp = (qty > 0 && hpp > 0) ? Math.round(hpp / qty) : 0;
                let acuanPasar = hs > 0 ? hs : (priceLookup[pkn] || 0);
                if (acuanPasar < unitHpp || acuanPasar === 0) {
                    acuanPasar = Math.round(unitHpp * 1.10); // Wajar: 10% di atas HPP produksi
                }

                let nilaiJual = (qty * acuanPasar);
                targetBranch.items[unit].totalJual += nilaiJual;
                pemakaianKandangDetail[unit].totalJual += nilaiJual;

                targetBranch.totalQty += qty;
                targetBranch.totalHpp += hpp;
                targetBranch.totalJual += nilaiJual;
            } else {
                // Transaksi Komersial Pihak Luar Murni
                if (isOngkir) {
                    revJasaOngkir += (totalNilai > 0 ? totalNilai : (hs > 0 ? hs : 0));
                } else {
                    revPenjualanPakan += totalNilai;
                    cogsPakanKomersial += hpp;
                    if (isHppSementara) {
                        cogsHasEstimasi = true;
                        countHppSementaraKomersial++;
                    }
                }
            }
        });

        // Fallback jika trxData kosong (gunakan data jurnal umum)
        if (revPenjualanPakan === 0 && revJasaOngkir === 0) {
            jData.forEach(d => {
                let kre = Number(d.kredit) || 0;
                let deb = Number(d.debit) || 0;
                let nama = (d.nama_akun || '').trim();
                if (nama === 'Pendapatan Penjualan') revPenjualanPakan += kre;
                if (nama === 'Harga Pokok Penjualan (HPP)') cogsPakanKomersial += deb;
                if (nama.toLowerCase().includes('pemakaian pakan kandang')) {
                    let rel = (d.relasi || '').trim() || 'Kandang Lainnya';
                    if (rel.toLowerCase() === 'kandang') return; // Drop logistik jangan dimasukkan
                    let ternakInfo = getKonsumsiTernakInfo({ relasi: rel, cabang: 'PM', status: 'Keluar' });
                    let cKey = ternakInfo ? ternakInfo.cabangKey : 'PM';
                    let uName = ternakInfo ? ternakInfo.unit : rel;
                    let targetBranch = pemakaianKandangPerCabang[cKey] || pemakaianKandangPerCabang['PM'];

                    if (!targetBranch.items[uName]) {
                        targetBranch.items[uName] = { unit: uName, totalQty: 0, totalHpp: 0, totalJual: 0 };
                    }
                    targetBranch.items[uName].totalHpp += deb;
                    let nj = Math.round(deb * 1.15);
                    targetBranch.items[uName].totalJual += nj;
                    targetBranch.totalHpp += deb;
                    targetBranch.totalJual += nj;

                    if (!pemakaianKandangDetail[uName]) {
                        pemakaianKandangDetail[uName] = { unit: uName, totalQty: 0, totalHpp: 0, totalJual: 0 };
                    }
                    pemakaianKandangDetail[uName].totalHpp += deb;
                    pemakaianKandangDetail[uName].totalJual += nj;
                }
            });
        }

        let totalPenjualanKotor = revPenjualanPakan + revJasaOngkir;
        let netSalesKomersial = totalPenjualanKotor - revDiskon - revRetur;
        let grossProfitKomersial = netSalesKomersial - cogsPakanKomersial;
        let grossMarginKomersial = netSalesKomersial > 0 ? ((grossProfitKomersial / netSalesKomersial) * 100).toFixed(1) : '0.0';

        // 3. Beban Operasional Gudang & Lapangan (Dikelompokkan per Kategori Cashflow)
        let bebanOperasionalMap = {};
        let bebanOperasionalDetailMap = {};
        cfData.forEach(c => {
            let rel = (c.relasi || '').trim();
            if (rel.toLowerCase().includes('bapera')) return;
            let kat = (c.kategori || '').trim() || 'Operasional Lainnya';
            let nom = Number(c.nominal) || 0;
            let ket = (c.keterangan || '').toLowerCase();

            // 🚨 FILTER CEGAH DOUBLE BIAYA & PENGELUARAN NON-BEBAN:
            // 1. Pengeluaran uang jalan supir ambil pakan supplier & bongkar muat masuk sudah melebur ke HPP Persediaan
            // 2. Pengeluaran Upah Giling dikapitalisasi ke HPP Persediaan pakan gilingan (RD/RL) & pelunasan Hutang Upah Giling
            // 3. Pengeluaran non-operasional (Bayar Hutang Pakan, Tarik Deposit, Kasbon, Bagi Hasil, Saldo Awal) bukan beban Laba Rugi
            let isPengantaranKomersial = ket.includes('pengantaran') || ket.includes('kirim ke') || ket.includes('antar ke');
            let isAmbilPakan = !isPengantaranKomersial && (kat.includes('OPR Ekspedisi') || kat.includes('Ekspedisi')) &&
                               (ket.includes('ambil') || ket.includes('pengambilan') || ket.includes('angkut') || ket.includes('jemput') || ket.includes('muat dari') || ket.includes('pembelian') || ket.includes('supplier'));
            let isBongkarMasuk = kat.includes('Bongkar') && (ket.includes('masuk') || ket.includes('bongkar pakan masuk') || ket.includes('pembelian') || ((ket.includes('[bm]') || ket.startsWith('bm ')) && !ket.includes('keluar')));
            let katLower = kat.toLowerCase();
            let isUpahGiling = katLower.includes('upah giling') || katLower.includes('opr giling') || katLower === 'giling' || (katLower.includes('giling') && !katLower.includes('ongkir'));
            let isNonBeban = katLower.includes('hutang') || katLower.includes('pembelian pakan') || katLower === 'tarik deposit' || katLower === 'kasbon' || (ket.includes('kasbon') && katLower !== 'kasbon mitra') || katLower === 'bagi hasil' || katLower === 'saldo awal';
            
            if (isAmbilPakan || isBongkarMasuk || isUpahGiling || isNonBeban) return;

            bebanOperasionalMap[kat] = (bebanOperasionalMap[kat] || 0) + nom;
            if (!bebanOperasionalDetailMap[kat]) bebanOperasionalDetailMap[kat] = [];
            bebanOperasionalDetailMap[kat].push({
                tanggal: c.tanggal || '',
                relasi: rel || '-',
                keterangan: (c.keterangan || '').trim() || '-',
                nominal: nom
            });
        });

        // Fallback beban jika cfData kosong
        if (Object.keys(bebanOperasionalMap).length === 0) {
            jData.forEach(d => {
                let deb = Number(d.debit) || 0;
                let nama = (d.nama_akun || '').trim();
                let kode = (d.kode_akun || '').charAt(0);
                if (kode === '5' && nama !== 'Biaya Diskon & Lain-lain' && !nama.toLowerCase().includes('pemakaian pakan') && !nama.toLowerCase().includes('upah giling')) {
                    bebanOperasionalMap[nama] = (bebanOperasionalMap[nama] || 0) + deb;
                    if (!bebanOperasionalDetailMap[nama]) bebanOperasionalDetailMap[nama] = [];
                    bebanOperasionalDetailMap[nama].push({
                        tanggal: d.tanggal || '',
                        relasi: (d.relasi || '').trim() || '-',
                        keterangan: (d.deskripsi || '').trim() || '-',
                        nominal: deb
                    });
                }
            });
        }

        let totalBebanOperasionalGudang = Object.values(bebanOperasionalMap).reduce((a, b) => a + b, 0);

        // 4. Laba Bersih Operasional Divisi Pakan (Standalone Surplus)
        let labaBersihDivisiPakan = grossProfitKomersial - totalBebanOperasionalGudang;
        let netMarginDivisiPakan = netSalesKomersial > 0 ? ((labaBersihDivisiPakan / netSalesKomersial) * 100).toFixed(1) : '0.0';

        // 5. Total Alokasi Pemakaian Kandang Internal (Holding)
        let totalPemakaianHpp = 0;
        let totalPemakaianJual = 0;
        let totalPemakaianQty = 0;
        Object.values(pemakaianKandangPerCabang).forEach(branch => {
            totalPemakaianHpp += branch.totalHpp;
            totalPemakaianJual += branch.totalJual;
            totalPemakaianQty += branch.totalQty;
        });
        let totalSubsidiInternal = totalPemakaianJual - totalPemakaianHpp;

        // 6. Hasil Konsolidasian Bersih Holding
        let labaBersihKonsolidasian = labaBersihDivisiPakan - totalPemakaianHpp;

        labaRugiDataGlobal = {
            periodeLabel,
            revPenjualanPakan,
            revJasaOngkir,
            totalPenjualanKotor,
            revDiskon,
            revRetur,
            netSalesKomersial,
            cogsPakanKomersial,
            cogsHasEstimasi,
            grossProfitKomersial,
            grossMarginKomersial,
            bebanOperasionalMap,
            bebanOperasionalDetailMap,
            totalBebanOperasionalGudang,
            labaBersihDivisiPakan,
            netMarginDivisiPakan,
            pemakaianKandangDetail,
            pemakaianKandangPerCabang,
            totalPemakaianQty,
            totalPemakaianHpp,
            totalPemakaianJual,
            totalSubsidiInternal,
            labaBersihKonsolidasian,
            countHppSementara,
            countHppSementaraKomersial,
            countHppSementaraInternal
        };

        renderLabaRugi(labaRugiDataGlobal);
    } catch (err) {
        console.error("Gagal memuat laba rugi:", err);
        alert("Gagal memuat laba rugi: " + err.message);
    } finally {
        loader?.classList.add('hidden');
    }
}

function renderLabaRugi(lr) {
    let cont = document.getElementById('lr-report-container');
    if (!cont || !lr) return;

    let nf = new Intl.NumberFormat('id-ID');
    let showKonsolidasi = document.getElementById('lr-toggle-konsolidasi')?.checked === true;
    let activeSementaraCount = showKonsolidasi
        ? (lr.countHppSementara || 0)
        : (lr.countHppSementaraKomersial || 0);

    // Rincian Beban Operasional Gudang & Lapangan (bisa diklik untuk lihat detail transaksi)
    let htmlBiayaOperasional = "";
    Object.keys(lr.bebanOperasionalMap).sort().forEach((kat, idxKat) => {
        let detList = (lr.bebanOperasionalDetailMap && lr.bebanOperasionalDetailMap[kat]) ? lr.bebanOperasionalDetailMap[kat] : [];
        let detRowsHtml = detList.map(item => {
            let tglStr = item.tanggal ? String(item.tanggal).split('-').reverse().join('/') : '-';
            return `
                <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:4px 6px; white-space:nowrap; color:#64748b;">${tglStr}</td>
                    <td style="padding:4px 6px; color:#334155; font-weight:500;">${escapeHtmlKP(item.relasi)}</td>
                    <td style="padding:4px 6px; color:#475569;">${escapeHtmlKP(item.keterangan)}</td>
                    <td style="padding:4px 6px; text-align:right; font-weight:600; color:#b91c1c; white-space:nowrap;">Rp ${nf.format(Math.round(item.nominal || 0))}</td>
                </tr>
            `;
        }).join('');

        htmlBiayaOperasional += `
            <div style="border-bottom:1px dashed #f1f5f9;">
                <div onclick="document.getElementById('lr-exp-det-${idxKat}')?.classList.toggle('hidden')" style="display:flex; justify-content:space-between; align-items:center; padding:5px 6px 5px 16px; font-size:12px; color:#475569; cursor:${detList.length > 0 ? 'pointer' : 'default'}; border-radius:4px;" title="${detList.length > 0 ? 'Klik untuk lihat rincian transaksi' : ''}">
                    <span>• ${escapeHtmlKP(kat)} ${detList.length > 0 ? `<span style="font-size:10px; background:#f1f5f9; color:#334155; padding:1px 6px; border-radius:10px; margin-left:4px; border:1px solid #e2e8f0;">${detList.length} tx ▾</span>` : ''}</span>
                    <span style="font-weight:600;">Rp ${nf.format(Math.round(lr.bebanOperasionalMap[kat] || 0))}</span>
                </div>
                ${detList.length > 0 ? `
                <div id="lr-exp-det-${idxKat}" class="hidden" style="margin:2px 0 8px 24px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; overflow-x:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:11px;">
                        <thead>
                            <tr style="background:#f1f5f9; color:#64748b; border-bottom:1px solid #e2e8f0;">
                                <th style="padding:4px 6px; text-align:left;">Tgl</th>
                                <th style="padding:4px 6px; text-align:left;">Relasi</th>
                                <th style="padding:4px 6px; text-align:left;">Keterangan</th>
                                <th style="padding:4px 6px; text-align:right;">Nominal</th>
                            </tr>
                        </thead>
                        <tbody>${detRowsHtml}</tbody>
                    </table>
                </div>` : ''}
            </div>
        `;
    });

    // Tabel Pemakaian Pakan Ternak Sendiri (Hanya jika mode Konsolidasian aktif)
    let activeBranches = Object.values(lr.pemakaianKandangPerCabang || {}).filter(b => Object.keys(b.items).length > 0);
    let htmlTablePemakaian = "";
    if (showKonsolidasi) {
        if (activeBranches.length > 0) {
            htmlTablePemakaian = `
                <div style="overflow-x:auto; margin-top:8px; border:1px solid #cbd5e1; border-radius:6px;">
                    <table style="width:100%; border-collapse:collapse; font-size:11px;">
                        <thead>
                            <tr style="background:#f1f5f9; color:#334155; border-bottom:1px solid #cbd5e1;">
                                <th style="padding:6px 8px; text-align:left;">Cabang / Unit Ternak</th>
                                <th style="padding:6px 8px; text-align:right;">Total Qty (Kg)</th>
                                <th style="padding:6px 8px; text-align:right;">Nilai Modal (HPP FIFO)</th>
                                <th style="padding:6px 8px; text-align:right;">Nilai Harga Jual Normal</th>
                                <th style="padding:6px 8px; text-align:right;">Selisih Nilai (Subsidi)</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            activeBranches.forEach((branch, bIdx) => {
                let branchItems = Object.values(branch.items).sort((a, b) => b.totalHpp - a.totalHpp);
                let branchSelisih = branch.totalJual - branch.totalHpp;

                let branchBg = branch.key === 'SPN' ? '#eff6ff' : (branch.key === 'RPH' ? '#fdf2f8' : '#f0fdf4');
                let branchColor = branch.key === 'SPN' ? '#1e40af' : (branch.key === 'RPH' ? '#9d174d' : '#166534');
                let branchIcon = branch.key === 'SPN' ? '🥛' : (branch.key === 'RPH' ? '🥩' : '🏢');

                htmlTablePemakaian += `
                    <tr style="background:${branchBg}; border-top:${bIdx > 0 ? '2px solid #cbd5e1' : 'none'}; border-bottom:1px solid #cbd5e1;">
                        <td colspan="5" style="padding:7px 8px; font-weight:bold; font-size:12px; color:${branchColor};">
                            ${branchIcon} ${escapeHtmlKP(branch.label)}
                        </td>
                    </tr>
                `;

                branchItems.forEach((u, idx) => {
                    let selisih = u.totalJual - u.totalHpp;
                    let bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
                    htmlTablePemakaian += `
                        <tr style="background:${bg}; border-bottom:1px solid #f1f5f9;">
                            <td style="padding:6px 8px 6px 24px; font-weight:600; color:#1e293b;">• ${escapeHtmlKP(u.unit)}</td>
                            <td style="padding:6px 8px; text-align:right;">${nf.format(u.totalQty)} Kg</td>
                            <td style="padding:6px 8px; text-align:right; font-weight:bold; color:${u.hasEstimasi ? '#2563eb' : '#c2410c'};" title="${u.hasEstimasi ? 'HPP Sementara (Estimasi) - Menunggu input HPP' : ''}">
                                Rp ${nf.format(u.totalHpp)}
                                ${u.hasEstimasi ? '<span style="font-size:9px; background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; border-radius:3px; padding:0 3px; margin-left:3px; font-weight:normal;">*Sementara</span>' : ''}
                            </td>
                            <td style="padding:6px 8px; text-align:right; color:#475569;">Rp ${nf.format(u.totalJual)}</td>
                            <td style="padding:6px 8px; text-align:right; color:#15803d; font-weight:600;">+Rp ${nf.format(selisih)}</td>
                        </tr>
                    `;
                });

                htmlTablePemakaian += `
                    <tr style="background:#f8fafc; font-weight:600; border-top:1px solid #e2e8f0; border-bottom:1px solid #cbd5e1; font-size:11px;">
                        <td style="padding:6px 8px 6px 20px; color:#475569; font-style:italic;">Subtotal ${escapeHtmlKP(branch.label)}</td>
                        <td style="padding:6px 8px; text-align:right; color:#334155;">${nf.format(branch.totalQty)} Kg</td>
                        <td style="padding:6px 8px; text-align:right; color:#c2410c;">Rp ${nf.format(branch.totalHpp)}</td>
                        <td style="padding:6px 8px; text-align:right; color:#475569;">Rp ${nf.format(branch.totalJual)}</td>
                        <td style="padding:6px 8px; text-align:right; color:#15803d;">+Rp ${nf.format(branchSelisih)}</td>
                    </tr>
                `;
            });

            htmlTablePemakaian += `
                        </tbody>
                        <tfoot>
                            <tr style="background:#f1f5f9; font-weight:bold; border-top:2px solid #cbd5e1;">
                                <td style="padding:8px; color:#0f172a;">TOTAL PEMAKAIAN INTERNAL (HOLDING)</td>
                                <td style="padding:8px; text-align:right; color:#0f172a;">${nf.format(lr.totalPemakaianQty)} Kg</td>
                                <td style="padding:8px; text-align:right; color:#c2410c;">Rp ${nf.format(lr.totalPemakaianHpp)}</td>
                                <td style="padding:8px; text-align:right; color:#0f172a;">Rp ${nf.format(lr.totalPemakaianJual)}</td>
                                <td style="padding:8px; text-align:right; color:#15803d;">+Rp ${nf.format(lr.totalSubsidiInternal)}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            `;
        } else {
            htmlTablePemakaian = `<div style="padding:10px 20px; font-size:12px; color:#94a3b8; font-style:italic;">Tidak ada data pemakaian pakan internal untuk periode ini.</div>`;
        }
    }

    cont.innerHTML = `
        <div style="text-align:center; border-bottom:2px solid #1e3a8a; padding-bottom:15px; margin-bottom:20px;">
            <h2 style="margin:0; font-size:20px; color:#1e3a8a; text-transform:uppercase; letter-spacing:0.5px;">PT. CITA BENGGALA LESTARI</h2>
            <div style="font-size:15px; font-weight:bold; color:#334155; margin-top:4px;">
                ${showKonsolidasi ? 'LAPORAN LABA RUGI KOMPREHENSIF (KONSOLIDASIAN HOLDING)' : 'LAPORAN LABA RUGI DIVISI PAKAN (KOMERSIAL STANDALONE)'}
            </div>
            <div style="font-size:12px; color:#64748b; margin-top:2px;">Periode: <b>${lr.periodeLabel}</b></div>
        </div>

        <!-- Banner Peringatan HPP Sementara (Jika Ada) -->
        ${activeSementaraCount > 0 ? `
        <div style="background:#eff6ff; border:1px solid #bfdbfe; border-left:4px solid #2563eb; border-radius:6px; padding:10px 14px; margin-bottom:18px; display:flex; align-items:flex-start; gap:10px; text-align:left;">
            <span class="material-symbols-outlined" style="color:#2563eb; font-size:20px; flex-shrink:0; margin-top:1px;">info</span>
            <div style="font-size:12px; color:#1e40af; line-height:1.5;">
                <b>Perhatian Akuntansi:</b> Terdapat <b>${activeSementaraCount} transaksi pakan</b> menggunakan <b>HPP Sementara / Estimasi (angka teks warna biru)</b> — <i>Menunggu input HPP</i>. Sistem menggunakan estimasi batch terakhir agar neraca & laba rugi tidak timpang, dan akan otomatis terbarui menjadi HPP riil saat harga pokok diinput.
            </div>
        </div>
        ` : ''}

        <!-- I. PENDAPATAN OPERASIONAL KOMERSIAL -->
        <div style="margin-bottom:15px;">
            <div style="font-weight:bold; font-size:13px; color:#1e3a8a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:8px;">
                I. PENDAPATAN OPERASIONAL KOMERSIAL (REVENUE)
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0 4px 10px; font-size:13px;">
                <span>Pendapatan Penjualan Pakan (Komersial)</span>
                <span style="font-weight:600;">Rp ${nf.format(lr.revPenjualanPakan)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0 4px 10px; font-size:13px; color:#0369a1;">
                <span>Pendapatan Jasa Ongkir / Ekspedisi Pengiriman</span>
                <span style="font-weight:600;">Rp ${nf.format(lr.revJasaOngkir)}</span>
            </div>
            ${lr.revRetur > 0 ? `
            <div style="display:flex; justify-content:space-between; padding:4px 0 4px 10px; font-size:13px; color:#b91c1c;">
                <span>Retur Penjualan</span>
                <span>(Rp ${nf.format(lr.revRetur)})</span>
            </div>` : ''}
            ${lr.revDiskon > 0 ? `
            <div style="display:flex; justify-content:space-between; padding:4px 0 4px 10px; font-size:13px; color:#b91c1c;">
                <span>Potongan & Diskon Penjualan</span>
                <span>(Rp ${nf.format(lr.revDiskon)})</span>
            </div>` : ''}
            <div style="display:flex; justify-content:space-between; padding:8px 10px; font-size:13px; font-weight:bold; background:#f8fafc; border-top:1px dashed #cbd5e1; margin-top:4px;">
                <span>TOTAL PENDAPATAN BERSIH KOMERSIAL (NET SALES)</span>
                <span style="color:#0369a1;">Rp ${nf.format(lr.netSalesKomersial)}</span>
            </div>
        </div>

        <!-- II. HARGA POKOK PENJUALAN KOMERSIAL -->
        <div style="margin-bottom:15px;">
            <div style="font-weight:bold; font-size:13px; color:#1e3a8a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:8px;">
                II. HARGA POKOK PENJUALAN KOMERSIAL (HPP FIFO / COGS)
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0 4px 10px; font-size:13px; color:${lr.cogsHasEstimasi ? '#2563eb' : '#b91c1c'}; font-weight:${lr.cogsHasEstimasi ? 'bold' : 'normal'};">
                <span>Beban Pokok Penjualan Pakan Komersial ${lr.cogsHasEstimasi ? '<span style="font-size:10px; background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; border-radius:3px; padding:0 4px; margin-left:4px;">*Termasuk Estimasi HPP</span>' : ''}</span>
                <span>(Rp ${nf.format(lr.cogsPakanKomersial)})</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:8px 10px; font-size:14px; font-weight:bold; background:#e0f2fe; border-top:1px solid #93c5fd; border-bottom:1px solid #93c5fd; margin-top:8px;">
                <span>LABA KOTOR KOMERSIAL (GROSS PROFIT)</span>
                <span style="color:#0369a1;">Rp ${nf.format(lr.grossProfitKomersial)} (${lr.grossMarginKomersial}%)</span>
            </div>
        </div>

        <!-- III. BEBAN OPERASIONAL GUDANG & LAPANGAN -->
        <div style="margin-bottom:15px;">
            <div style="font-weight:bold; font-size:13px; color:#1e3a8a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:8px;">
                III. BEBAN OPERASIONAL GUDANG & LAPANGAN (OPERATING EXPENSES)
            </div>
            ${htmlBiayaOperasional || '<div style="padding-left:20px; font-size:12px; color:#94a3b8;">Tidak ada data biaya operasional.</div>'}
            <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; font-weight:bold; background:#fef2f2; border-top:1px dashed #fca5a5; margin-top:6px; color:#b91c1c;">
                <span>TOTAL BEBAN OPERASIONAL GUDANG</span>
                <span>(Rp ${nf.format(lr.totalBebanOperasionalGudang)})</span>
            </div>
        </div>

        <!-- BANNER SURPLUS OPERASIONAL DIVISI PAKAN KOMERSIAL -->
        <div style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; font-size:15px; font-weight:bold; background:#ecfdf5; border:2px solid #10b981; border-radius:8px; color:#065f46; margin-bottom:${showKonsolidasi ? '25px' : '5px'};">
            <div>
                <div>LABA BERSIH OPERASIONAL DIVISI PAKAN (STANDALONE SURPLUS)</div>
                <div style="font-size:11px; font-weight:normal; color:#047857; margin-top:2px;">
                    Margin Operasional Divisi: <b>${lr.netMarginDivisiPakan}%</b> dari Omzet Komersial.
                </div>
            </div>
            <div style="font-size:22px; font-weight:900;">Rp ${nf.format(lr.labaBersihDivisiPakan)}</div>
        </div>

        ${showKonsolidasi ? `
        <!-- IV. ALOKASI KONSUMSI PAKAN TERNAK SENDIRI (HOLDING INTERNAL) -->
        <div style="margin-bottom:20px; background:#fbfcfe; padding:15px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-weight:bold; font-size:13px; color:#1e3a8a; border-bottom:1px solid #cbd5e1; padding-bottom:4px; margin-bottom:6px;">
                IV. ALOKASI KONSUMSI PAKAN TERNAK SENDIRI (HOLDING INTERNAL)
            </div>
            <div style="font-size:11px; color:#64748b; line-height:1.4; margin-bottom:8px;">
                Pakan yang dikonsumsi oleh unit peternakan sendiri dinilai dengan 2 acuan harga: <b>Nilai Modal HPP (FIFO)</b> dan <b>Nilai Harga Jual Normal (Pasar)</b>.
            </div>
            
            ${htmlTablePemakaian}

            <div style="font-size:11px; color:#475569; background:#fffbeb; border:1px solid #fef3c7; border-radius:6px; padding:10px; margin-top:10px; line-height:1.5;">
                <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; color:#b45309; margin-right:3px;">info</span>
                <b>Catatan Akuntansi Pemeliharaan:</b> Pakan yang dikirim ke unit <b>SPN (Sapi Perah)</b> menghasilkan pendapatan penjualan susu harian yang dicatat pada pembukuan terpisah divisi SPN. Konsumsi pada kandang <b>PM / RPH</b> terkonversi menjadi pertambahan bobot daging ternak. Selisih nilai <b>+Rp ${nf.format(lr.totalSubsidiInternal)}</b> adalah efisiensi penghematan modal yang dinikmati grup peternakan.
            </div>
        </div>

        <!-- V. HASIL AKHIR KONSOLIDASIAN -->
        <div style="padding:15px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:8px; font-size:13px;">
            <div style="font-weight:bold; font-size:13px; color:#334155; margin-bottom:8px;">V. HASIL AKHIR KONSOLIDASIAN HOLDING</div>
            <div style="display:flex; justify-content:space-between; padding:4px 0;">
                <span>Laba Bersih Divisi Pakan (Komersial)</span>
                <span style="font-weight:600; color:#15803d;">Rp ${nf.format(lr.labaBersihDivisiPakan)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0; color:#c2410c;">
                <span>Alokasi Modal Pakan Ternak Sendiri (Beban HPP)</span>
                <span>(Rp ${nf.format(lr.totalPemakaianHpp)})</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:10px 0 0 0; font-size:15px; font-weight:bold; border-top:2px solid #cbd5e1; margin-top:6px; color:#1e293b;">
                <span>HASIL BERSIH KONSOLIDASIAN</span>
                <span>Rp ${nf.format(lr.labaBersihKonsolidasian)}</span>
            </div>
        </div>
        ` : `
        <div style="margin-top:12px; padding:10px 14px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:6px; font-size:11.5px; color:#64748b;">
            <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; margin-right:4px;">visibility_off</span>
            Alokasi pemakaian pakan ternak kandang sendiri (<b>Rp ${nf.format(Math.round(lr.totalPemakaianHpp || 0))}</b> dari ${nf.format(Math.round(lr.totalPemakaianQty || 0))} Kg) saat ini dipisahkan agar tidak membebani performa komersial Divisi Pakan. Centang opsi di atas bila ingin melihat tampilan Konsolidasian Holding.
        </div>
        `}
    `;
}

function toggleDropdownExportLR(e) {
    if (e) e.stopPropagation();
    let dd = document.getElementById('dropdown-export-lr');
    dd?.classList.toggle('hidden');
}

function exportLabaRugi(fmt) {
    document.getElementById('dropdown-export-lr')?.classList.add('hidden');
    if (!labaRugiDataGlobal) {
        alert("Silakan klik Tampilkan terlebih dahulu!");
        return;
    }
    let lr = labaRugiDataGlobal;
    let showKonsolidasi = document.getElementById('lr-toggle-konsolidasi')?.checked === true;
    let filename = `Laba_Rugi_CBL_${showKonsolidasi ? 'Konsolidasi_' : 'Divisi_Pakan_'}${lr.periodeLabel.replace(/\s+/g, '_')}`;

    if (fmt === 'pdf') {
        cetakPdfLabaRugi(lr, filename, showKonsolidasi);
        return;
    }

    let rows = [
        { 'Pos Akun': 'I. PENDAPATAN OPERASIONAL KOMERSIAL', 'Keterangan': '', 'Jumlah (Rp)': '' },
        { 'Pos Akun': 'Pendapatan Penjualan Pakan (Komersial)', 'Keterangan': 'Penjualan ke Pihak Luar', 'Jumlah (Rp)': lr.revPenjualanPakan },
        { 'Pos Akun': 'Pendapatan Jasa Ongkir / Ekspedisi', 'Keterangan': 'Ongkir Pengiriman Terpisah', 'Jumlah (Rp)': lr.revJasaOngkir },
        { 'Pos Akun': 'Retur Penjualan', 'Keterangan': 'Debit Akun 4', 'Jumlah (Rp)': -lr.revRetur },
        { 'Pos Akun': 'Potongan & Diskon Penjualan', 'Keterangan': 'Debit Akun 5', 'Jumlah (Rp)': -lr.revDiskon },
        { 'Pos Akun': 'TOTAL PENDAPATAN BERSIH KOMERSIAL', 'Keterangan': 'Net Sales Komersial', 'Jumlah (Rp)': lr.netSalesKomersial },
        { 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' },
        { 'Pos Akun': 'II. HARGA POKOK PENJUALAN KOMERSIAL', 'Keterangan': '', 'Jumlah (Rp)': '' },
        { 'Pos Akun': 'Harga Pokok Penjualan (HPP FIFO)', 'Keterangan': 'COGS Penjualan Luar', 'Jumlah (Rp)': -lr.cogsPakanKomersial },
        { 'Pos Akun': 'LABA KOTOR KOMERSIAL (GROSS PROFIT)', 'Keterangan': `${lr.grossMarginKomersial}% Margin`, 'Jumlah (Rp)': lr.grossProfitKomersial },
        { 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' },
        { 'Pos Akun': 'III. BEBAN OPERASIONAL GUDANG & LAPANGAN', 'Keterangan': '', 'Jumlah (Rp)': '' }
    ];

    Object.keys(lr.bebanOperasionalMap).forEach(kat => {
        rows.push({ 'Pos Akun': 'Biaya: ' + kat, 'Keterangan': 'Beban Gudang & Lapangan', 'Jumlah (Rp)': -lr.bebanOperasionalMap[kat] });
    });

    rows.push({ 'Pos Akun': 'TOTAL BEBAN OPERASIONAL GUDANG', 'Keterangan': '', 'Jumlah (Rp)': -lr.totalBebanOperasionalGudang });
    rows.push({ 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' });
    rows.push({ 'Pos Akun': 'LABA BERSIH DIVISI PAKAN (STANDALONE SURPLUS)', 'Keterangan': `${lr.netMarginDivisiPakan}% Margin Operasional`, 'Jumlah (Rp)': lr.labaBersihDivisiPakan });

    if (showKonsolidasi) {
        rows.push({ 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' });
        rows.push({ 'Pos Akun': 'IV. ALOKASI KONSUMSI PAKAN TERNAK SENDIRI', 'Keterangan': '', 'Jumlah (Rp)': '' });
        let activeBranches = Object.values(lr.pemakaianKandangPerCabang || {}).filter(b => Object.keys(b.items).length > 0);
        if (activeBranches.length > 0) {
            activeBranches.forEach(branch => {
                rows.push({ 'Pos Akun': `[${branch.label}]`, 'Keterangan': '', 'Jumlah (Rp)': '' });
                Object.values(branch.items).sort((a, b) => b.totalHpp - a.totalHpp).forEach(u => {
                    rows.push({
                        'Pos Akun': `  • ${u.unit} (${u.totalQty.toLocaleString('id-ID')} Kg)`,
                        'Keterangan': `HPP: Rp ${u.totalHpp.toLocaleString('id-ID')} | Pasar: Rp ${u.totalJual.toLocaleString('id-ID')}${u.hasEstimasi ? ' (*Sementara)' : ''}`,
                        'Jumlah (Rp)': -u.totalHpp
                    });
                });
                rows.push({
                    'Pos Akun': `  Subtotal ${branch.label}`,
                    'Keterangan': `${branch.totalQty.toLocaleString('id-ID')} Kg`,
                    'Jumlah (Rp)': -branch.totalHpp
                });
                rows.push({ 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' });
            });
        }

        rows.push({ 'Pos Akun': 'TOTAL ALOKASI MODAL PAKAN INTERNAL', 'Keterangan': `Efisiensi Subsidi: Rp ${lr.totalSubsidiInternal.toLocaleString('id-ID')}`, 'Jumlah (Rp)': -lr.totalPemakaianHpp });
        rows.push({ 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' });
        rows.push({ 'Pos Akun': 'V. HASIL BERSIH KONSOLIDASIAN HOLDING', 'Keterangan': 'Laba Bersih Divisi - Modal Pemakaian Internal', 'Jumlah (Rp)': lr.labaBersihKonsolidasian });
    }

    if (fmt === 'xlsx' && typeof XLSX !== 'undefined') {
        let wb = XLSX.utils.book_new();
        let ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 42 }, { wch: 35 }, { wch: 22 }];
        XLSX.utils.book_append_sheet(wb, ws, "Laba Rugi");
        XLSX.writeFile(wb, `${filename}.xlsx`);
    } else {
        let csvHeader = Object.keys(rows[0]).join(";");
        let csvBody = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
        let csv = "\uFEFFsep=;\r\n" + csvHeader + "\r\n" + csvBody;
        let blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${filename}.csv`;
        a.click();
    }
}


// =========================================================================
// SUB-MENU 4: LAPORAN NERACA (BALANCE SHEET)
// =========================================================================

let neracaDataGlobal = null;

function initTanggalNeraca() {
    let selBulan = document.getElementById('neraca-bulan');
    let selTahun = document.getElementById('neraca-tahun');
    if (selBulan && (!selBulan.value || selBulan.value === 'ALL')) {
        let now = new Date();
        selBulan.value = ("0" + (now.getMonth() + 1)).slice(-2);
        if (selTahun) selTahun.value = now.getFullYear();
    }
}

async function muatNeraca() {
    let loader = document.getElementById('neraca-loader');
    loader?.classList.remove('hidden');

    try {
        let bulan = document.getElementById('neraca-bulan')?.value || 'ALL';
        let tahun = document.getElementById('neraca-tahun')?.value || new Date().getFullYear();

        let endDate = `${tahun}-12-31`;
        let asOfLabel = `31 Desember ${tahun}`;
        if (bulan && bulan !== 'ALL') {
            let lastDay = new Date(tahun, Number(bulan), 0).getDate();
            endDate = `${tahun}-${bulan}-${("0" + lastDay).slice(-2)}`;
            let namaBulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"][Number(bulan) - 1];
            asOfLabel = `${lastDay} ${namaBulan} ${tahun}`;
        }

        let headers = {
            'apikey': SUPA_ANON_KEY,
            'Authorization': `Bearer ${SUPA_ANON_KEY}`
        };

        // 1-5. Tarik ringkasan jurnal via RPC cepat (fallback ke paged view jika RPC belum terpasang), stok aktif, piutang, gilingan, dan pembayaran upah giling hingga endDate
        let fetchNeracaJurnal = async () => {
            try {
                let rpcRes = await fetch(`${SUPA_URL}/rest/v1/rpc/get_neraca_summary`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ p_end_date: endDate })
                });
                if (rpcRes.ok) {
                    let sumRows = await rpcRes.json();
                    if (Array.isArray(sumRows)) {
                        return sumRows.map(s => ({
                            id_jurnal: s.has_giling ? 'TP-GIL-RPC' : 'RPC-SUM',
                            kode_akun: s.kode_akun,
                            nama_akun: s.nama_akun,
                            debit: Number(s.total_debit) || 0,
                            kredit: Number(s.total_kredit) || 0,
                            is_prior_year: s.is_prior_year !== undefined ? Boolean(s.is_prior_year) : undefined
                        }));
                    }
                }
            } catch (eRpc) { /* fallback ke view_jurnal_umum */ }
            return fetchJurnalPaged(`${SUPA_URL}/rest/v1/view_jurnal_umum?tanggal=lte.${endDate}&select=tanggal,id_jurnal,kode_akun,nama_akun,debit,kredit&order=tanggal.asc,id_jurnal.asc`, headers);
        };

        let [jData, bData, pData, gilingTrxData, cfGilingData] = await Promise.all([
            fetchNeracaJurnal(),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/stok_batch?qty_sisa=gt.0&tanggal_masuk=lte.${endDate}&select=pakan,qty_sisa,hpp`, headers),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/view_rekap_piutang?select=sisa_piutang`, headers),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/transaksi_pakan?status=eq.Keluar&tanggal=lte.${endDate}&or=(relasi.ilike.rd,relasi.ilike.rl,relasi.ilike.darbun,relasi.ilike.laktasi)&select=cabang,relasi,pakan,qty,hash_str`, headers),
            fetchJurnalPaged(`${SUPA_URL}/rest/v1/cashflow?jenis=ilike.*keluar*&tanggal=lte.${endDate}&select=kategori,keterangan,nominal,relasi`, headers)
        ]);

        // Hitung Saldo Akun Kumulatif
        let saldoKas = 0;
        let saldoPiutangJurnal = 0;
        let saldoKasbonJurnal = 0;
        let saldoPersediaanJurnal = 0;
        let saldoHutang = 0;
        let saldoHutangUpahGilingJurnal = 0;
        let hasJurnalGilingSql = false;
        let modalDisetorJurnal = 0;

        let totalRev = 0;
        let totalExp = 0;
        let totalPemakaianKandangRaw = 0;
        let pemakaianKandangPriorRaw = 0;
        let labaDitahanPriorRaw = 0;
        let hasPriorYearCutoff = false;
        let priorYear = Number(tahun) - 1;

        jData.forEach(d => {
            let deb = Number(d.debit) || 0;
            let kre = Number(d.kredit) || 0;
            let nama = (d.nama_akun || '').trim();
            let namaLow = nama.toLowerCase();
            let kode = (d.kode_akun || '').charAt(0);
            let isPriorYear = d.is_prior_year !== undefined
                ? Boolean(d.is_prior_year)
                : (d.tanggal ? String(d.tanggal).slice(0, 4) < String(tahun) : false);

            if (String(d.id_jurnal || '').startsWith('TP-GIL-') || nama === 'Hutang Upah Giling') {
                hasJurnalGilingSql = true;
            }

            if (nama === 'Kas' || (kode === '1' && namaLow.includes('kas') && !namaLow.includes('kasbon'))) {
                saldoKas += (deb - kre);
            } else if (kode === '1' && (namaLow.includes('kasbon') || namaLow.includes('karyawan'))) {
                saldoKasbonJurnal += (deb - kre);
            } else if (nama === 'Piutang Pakan' || (kode === '1' && namaLow.includes('piutang'))) {
                saldoPiutangJurnal += (deb - kre);
            } else if (nama === 'Persediaan Pakan' || (kode === '1' && namaLow.includes('persediaan'))) {
                saldoPersediaanJurnal += (deb - kre);
            } else if (nama === 'Hutang Upah Giling' || (kode === '2' && namaLow.includes('upah giling'))) {
                saldoHutangUpahGilingJurnal += (kre - deb);
            } else if (nama === 'Hutang Pakan' || (kode === '2' && namaLow.includes('hutang'))) {
                saldoHutang += (kre - deb);
            } else if (kode === '3') {
                modalDisetorJurnal += (kre - deb);
            }

            // Cut-off tahunan: Laba/Rugi tahun sebelumnya (< tahun) ditutup ke Laba Ditahan; Laba/Rugi tahun berjalan dihitung khusus tahun terpilih
            if (kode === '4' || kode === '5') {
                if (isPriorYear) {
                    hasPriorYearCutoff = true;
                    labaDitahanPriorRaw += (kode === '4') ? (kre - deb) : -(deb - kre);
                    if (kode === '5' && namaLow.includes('pemakaian pakan')) {
                        pemakaianKandangPriorRaw += (deb - kre);
                    }
                } else if (kode === '4') {
                    totalRev += (kre - deb);
                } else if (kode === '5') {
                    totalExp += (deb - kre);
                    if (namaLow.includes('pemakaian pakan')) {
                        totalPemakaianKandangRaw += (deb - kre);
                    }
                }
            }
        });

        // Hitung Hutang Upah Giling Akumulasi (prioritaskan jurnal SQL baru bila tersedia; fallback ke perhitungan manual bila SQL belum diupdate)
        let saldoHutangUpahGiling = 0;
        if (hasJurnalGilingSql) {
            saldoHutangUpahGiling = saldoHutangUpahGilingJurnal;
        } else {
            let totalKgGiling = 0;
            gilingTrxData.forEach(t => {
                let hash = (t.hash_str || '').toUpperCase();
                let cab = (t.cabang || '').toUpperCase();
                let rel = (t.relasi || '').trim().toUpperCase();
                if (hash.includes('_GILING_') || cab.includes('KANDANG')) return;
                if (isPakanGilingJadi(t.pakan)) return;
                if (rel === 'RD' || rel === 'RL' || rel === 'DARBUN' || rel === 'LAKTASI') {
                    totalKgGiling += (Number(t.qty) || 0);
                }
            });
            let totalKewajibanUpahGiling = Math.round(totalKgGiling * 100);
            let totalBayarUpahGiling = 0;
            cfGilingData.forEach(c => {
                if ((c.relasi || '').toLowerCase().includes('bapera')) return;
                let katLower = (c.kategori || '').trim().toLowerCase();
                if (katLower.includes('upah giling') || katLower.includes('opr giling') || katLower === 'giling' || (katLower.includes('giling') && !katLower.includes('ongkir'))) {
                    totalBayarUpahGiling += (Number(c.nominal) || 0);
                }
            });
            saldoHutangUpahGiling = totalKewajibanUpahGiling - totalBayarUpahGiling;
        }

        // Valuasi Persediaan: jika SQL baru sudah memasukkan kapitalisasi +Rp 100/Kg ke Persediaan Pakan, pakai saldoPersediaanJurnal langsung tanpa dobel tambah
        let totalUpahGilingStokAktif = bData.reduce((acc, b) => acc + (isPakanGilingJadi(b.pakan) ? ((Number(b.qty_sisa) || 0) * 100) : 0), 0);
        let saldoPersediaanFisik = Math.round(bData.reduce((acc, b) => acc + ((Number(b.qty_sisa) || 0) * ((Number(b.hpp) || 0) + (isPakanGilingJadi(b.pakan) ? 100 : 0))), 0));
        let saldoPersediaanRaw = saldoPersediaanJurnal > 0
            ? (hasJurnalGilingSql ? saldoPersediaanJurnal : (saldoPersediaanJurnal + totalUpahGilingStokAktif))
            : saldoPersediaanFisik;

        // Piutang: Fallback ke rekap piutang hanya jika jurnal belum ada data
        let totalPiutangRekap = pData.reduce((acc, p) => acc + (Number(p.sisa_piutang) || 0), 0);
        let saldoPiutangRaw = jData.length > 0 ? saldoPiutangJurnal : totalPiutangRekap;

        // Pembulatan bulat Rupiah tanpa angka di belakang koma
        saldoKas = Math.round(saldoKas);
        let saldoPiutang = Math.round(saldoPiutangRaw);
        let saldoKasbon = Math.round(saldoKasbonJurnal);
        let saldoPersediaan = Math.round(saldoPersediaanRaw);
        let totalAktiva = saldoKas + saldoPiutang + saldoKasbon + saldoPersediaan;

        saldoHutang = Math.round(saldoHutang);
        saldoHutangUpahGiling = Math.round(saldoHutangUpahGiling);
        let totalKewajiban = saldoHutang + saldoHutangUpahGiling;

        // Laba/Rugi & alokasi kandang: siapkan angka Mode Komersial Mandiri (Piutang Antar-Divisi) maupun Mode Prive/Konsolidasian
        let labaBerjalan = Math.round(totalRev - totalExp);
        let totalPemakaianKandangKumulatif = Math.round(totalPemakaianKandangRaw);
        let piutangAntarDivisi = Math.round(pemakaianKandangPriorRaw + totalPemakaianKandangRaw);
        let pemakaianKandangPrior = piutangAntarDivisi - totalPemakaianKandangKumulatif;
        let labaKomersialKumulatif = labaBerjalan + totalPemakaianKandangKumulatif;

        let ekuitasModalPrive = Math.round(modalDisetorJurnal + labaDitahanPriorRaw);
        let ekuitasModalKomersial = ekuitasModalPrive + pemakaianKandangPrior;
        let totalEkuitasPrive = ekuitasModalPrive + labaKomersialKumulatif - totalPemakaianKandangKumulatif;
        let totalPasivaPrive = totalKewajiban + totalEkuitasPrive;

        // Selisih riil identik di kedua mode (Komersial Mandiri & Prive/Konsolidasian)
        let selisih = totalAktiva - totalPasivaPrive;

        neracaDataGlobal = {
            asOfLabel,
            tahunDipilih: tahun,
            priorYear,
            hasPriorYearCutoff,
            saldoKas,
            saldoPiutang,
            saldoKasbon,
            piutangAntarDivisi,
            saldoPersediaan,
            saldoPersediaanFisik,
            totalAktiva,
            saldoHutang,
            saldoHutangUpahGiling,
            totalKewajiban,
            ekuitasModal: ekuitasModalPrive,
            ekuitasModalPrive,
            ekuitasModalKomersial,
            labaBerjalan,
            labaKomersialKumulatif,
            pemakaianKandangPrior,
            totalPemakaianKandangKumulatif,
            totalEkuitas: totalEkuitasPrive,
            totalPasiva: totalPasivaPrive,
            selisih
        };

        renderNeraca(neracaDataGlobal);
    } catch (err) {
        console.error("Gagal memuat neraca:", err);
        alert("Gagal memuat neraca: " + err.message);
    } finally {
        loader?.classList.add('hidden');
    }
}

function getNeracaViewModel(n) {
    let showPrive = Boolean(document.getElementById('neraca-toggle-prive')?.checked);
    let piutangDivisiKandang = !showPrive ? (n.piutangAntarDivisi || 0) : 0;
    let totalAktiva = n.totalAktiva + piutangDivisiKandang;
    let ekuitasModal = !showPrive
        ? (n.ekuitasModalKomersial !== undefined ? n.ekuitasModalKomersial : n.ekuitasModal)
        : (n.ekuitasModalPrive !== undefined ? n.ekuitasModalPrive : n.ekuitasModal);
    let potonganPrive = showPrive ? (n.totalPemakaianKandangKumulatif || 0) : 0;
    let totalEkuitas = ekuitasModal + (n.labaKomersialKumulatif || 0) - potonganPrive;
    let totalPasiva = n.totalKewajiban + totalEkuitas;
    let selisih = totalAktiva - totalPasiva;
    return {
        ...n,
        showPrive,
        piutangDivisiKandang,
        totalAktiva,
        ekuitasModal,
        potonganPrive,
        totalEkuitas,
        totalPasiva,
        selisih,
        modalLabel: n.hasPriorYearCutoff ? `Modal Disetor & Laba Ditahan (s/d ${n.priorYear})` : 'Modal Disetor & Laba Ditahan',
        labaLabel: n.hasPriorYearCutoff ? `Laba Bersih Penjualan Komersial (${n.tahunDipilih})` : `Laba Bersih Penjualan Komersial (s/d ${n.asOfLabel})`,
        priveLabel: n.hasPriorYearCutoff ? `Alokasi Pakan Kandang Sendiri (${n.tahunDipilih} - Prive)` : 'Alokasi Pakan Kandang Sendiri (Prive Internal)'
    };
}

function renderNeraca(n) {
    let cont = document.getElementById('neraca-report-container');
    if (!cont || !n) return;

    let v = getNeracaViewModel(n);
    let nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
    let isBalance = Math.abs(v.selisih) <= 2;

    cont.innerHTML = `
        <div style="text-align:center; border-bottom:2px solid #1e3a8a; padding-bottom:15px; margin-bottom:15px;">
            <h2 style="margin:0; font-size:20px; color:#1e3a8a; text-transform:uppercase; letter-spacing:0.5px;">PT. CITA BENGGALA LESTARI</h2>
            <div style="font-size:15px; font-weight:bold; color:#334155; margin-top:4px;">LAPORAN POSISI KEUANGAN (NERACA${v.showPrive ? ' — KONSOLIDASIAN' : ' — DIVISI PAKAN'})</div>
            <div style="font-size:12px; color:#64748b; margin-top:2px;">Posisi Per: <b>${v.asOfLabel}</b></div>
        </div>

        <!-- Status Balance Banner -->
        ${isBalance ? `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 15px; border-radius:6px; margin-bottom:20px; font-size:13px; font-weight:bold; background:#ecfdf5; color:#065f46; border:1px solid #a7f3d0;">
            <span>STATUS: NERACA 100% BALANCE (AKTIVA = PASIVA)</span>
            <span>Selisih: Rp ${nf.format(Math.abs(v.selisih) <= 2 ? 0 : v.selisih)}</span>
        </div>
        ` : `
        <div style="background:#fffbeb; border:1px solid #fde68a; border-left:4px solid #f59e0b; border-radius:6px; padding:12px 15px; margin-bottom:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px; font-weight:bold; color:#b45309;">
                <span>STATUS: TERDAPAT REKONSILIASI FISIK GUDANG</span>
                <span>Selisih: Rp ${nf.format(v.selisih)}</span>
            </div>
            <div style="font-size:11.5px; color:#92400e; margin-top:5px; line-height:1.4;">
                Persediaan fisik di gudang bernilai <b>Rp ${nf.format(v.saldoPersediaan)}</b>. Selisih ini mencerminkan aset fisik yang sudah berada di gudang namun input HPP / faktur pembelian supplier belum dicatat dalam jurnal pembukuan (Hutang/Kas). Begitu pencatatan jurnal pembelian masuk dan HPP diselesaikan, posisi neraca akan otomatis seimbang.
            </div>
        </div>
        `}

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:25px;">
            <!-- BAGIAN KIRI: AKTIVA (ASET) -->
            <div>
                <div style="font-weight:bold; font-size:14px; color:#1e3a8a; border-bottom:2px solid #0284c7; padding-bottom:6px; margin-bottom:10px;">
                    AKTIVA (ASET) — [KODE 1]
                </div>
                
                <div style="font-weight:600; font-size:12px; color:#475569; margin-bottom:6px;">Aset Lancar:</div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Kas & Bank</span>
                    <span style="font-weight:600;">Rp ${nf.format(v.saldoKas)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Piutang Pakan Peternak</span>
                    <span style="font-weight:600;">Rp ${nf.format(v.saldoPiutang)}</span>
                </div>
                ${(v.saldoKasbon || 0) !== 0 ? `
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Piutang Karyawan (Kasbon)</span>
                    <span style="font-weight:600;">Rp ${nf.format(v.saldoKasbon)}</span>
                </div>
                ` : ''}
                ${(v.piutangDivisiKandang || 0) !== 0 ? `
                <div style="display:flex; justify-content:space-between; gap:10px; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9; background:#f8fafc;">
                    <span style="color:#0369a1;">• Piutang Antar-Divisi (Kandang Sendiri)</span>
                    <span style="font-weight:600; color:#0369a1; white-space:nowrap;">Rp ${nf.format(v.piutangDivisiKandang)}</span>
                </div>
                ` : ''}
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Persediaan Pakan di Gudang (FIFO)</span>
                    <span style="font-weight:600;">Rp ${nf.format(v.saldoPersediaan)}</span>
                </div>

                <div style="display:flex; justify-content:space-between; padding:12px 10px; font-size:15px; font-weight:bold; background:#e0f2fe; border-radius:6px; margin-top:25px; border-top:2px solid #0284c7;">
                    <span>TOTAL AKTIVA (ASET)</span>
                    <span style="color:#0369a1;">Rp ${nf.format(v.totalAktiva)}</span>
                </div>
            </div>

            <!-- BAGIAN KANAN: PASIVA (KEWAJIBAN & EKUITAS) -->
            <div>
                <div style="font-weight:bold; font-size:14px; color:#1e3a8a; border-bottom:2px solid #f59e0b; padding-bottom:6px; margin-bottom:10px;">
                    PASIVA (KEWAJIBAN & EKUITAS)
                </div>

                <div style="font-weight:600; font-size:12px; color:#475569; margin-bottom:6px;">I. Kewajiban / Hutang [KODE 2]:</div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Hutang Usaha Supplier Pakan</span>
                    <span style="font-weight:600;">Rp ${nf.format(v.saldoHutang)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Hutang Upah Giling</span>
                    <span style="font-weight:600; color:#0f766e;">Rp ${nf.format(v.saldoHutangUpahGiling || 0)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:12px; font-weight:bold; background:#f8fafc; color:#64748b; margin-bottom:12px;">
                    <span>Total Kewajiban</span>
                    <span>Rp ${nf.format(v.totalKewajiban)}</span>
                </div>

                <div style="font-weight:600; font-size:12px; color:#475569; margin-bottom:6px;">II. Ekuitas / Modal [KODE 3]:</div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• ${v.modalLabel}</span>
                    <span style="font-weight:600;">Rp ${nf.format(v.ekuitasModal)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; gap:12px; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9; color:${(v.labaKomersialKumulatif || 0) >= 0 ? '#15803d' : '#b91c1c'};">
                    <span>• ${v.labaLabel}</span>
                    <span style="font-weight:700; white-space:nowrap;">${(v.labaKomersialKumulatif || 0) >= 0 ? '+' : ''}Rp ${nf.format(v.labaKomersialKumulatif || 0)}</span>
                </div>
                ${(v.potonganPrive || 0) !== 0 ? `
                <div style="display:flex; justify-content:space-between; gap:12px; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9; color:#475569;">
                    <span>• ${v.priveLabel}</span>
                    <span style="font-weight:600; white-space:nowrap;">(Rp ${nf.format(v.potonganPrive)})</span>
                </div>
                <div style="padding:4px 10px 6px; font-size:11px; color:#64748b; border-bottom:1px solid #f1f5f9; background:#f8fafc;">
                    Alokasi kandang mengurangi stok gudang tanpa mengurangi laba penjualan komersial (karena omzet susu/sapi dicatat terpisah dari buku pakan).
                </div>
                ` : (!v.showPrive && (v.piutangAntarDivisi || 0) !== 0 ? `
                <div style="padding:4px 10px 6px; font-size:11px; color:#0369a1; border-bottom:1px solid #f1f5f9; background:#f0f9ff;">
                    Ekuitas murni mencerminkan kinerja penjualan pakan komersial; pemakaian kandang sendiri dicatat sebagai <b>Piutang Antar-Divisi</b> di Aktiva. Centang opsi Konsolidasian di atas untuk mode Prive.
                </div>
                ` : '')}
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:12px; font-weight:bold; background:#f8fafc; color:#64748b; margin-bottom:12px;">
                    <span>Total Ekuitas</span>
                    <span>Rp ${nf.format(v.totalEkuitas)}</span>
                </div>

                <div style="display:flex; justify-content:space-between; padding:12px 10px; font-size:15px; font-weight:bold; background:#fef3c7; border-radius:6px; margin-top:10px; border-top:2px solid #f59e0b;">
                    <span>TOTAL PASIVA</span>
                    <span style="color:#b45309;">Rp ${nf.format(v.totalPasiva)}</span>
                </div>
            </div>
        </div>
    `;
}

function toggleDropdownExportNeraca(e) {
    if (e) e.stopPropagation();
    let dd = document.getElementById('dropdown-export-neraca');
    dd?.classList.toggle('hidden');
}

function exportNeraca(fmt) {
    document.getElementById('dropdown-export-neraca')?.classList.add('hidden');
    if (!neracaDataGlobal) {
        alert("Silakan klik Tampilkan terlebih dahulu!");
        return;
    }
    let v = getNeracaViewModel(neracaDataGlobal);
    let filename = `Neraca_CBL_${v.asOfLabel.replace(/\s+/g, '_')}${v.showPrive ? '_Konsolidasian' : '_Komersial'}`;

    if (fmt === 'pdf') {
        cetakPdfNeraca(neracaDataGlobal, filename);
        return;
    }

    let rows = [
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Kas & Bank', 'Saldo (Rp)': v.saldoKas },
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Piutang Pakan Peternak', 'Saldo (Rp)': v.saldoPiutang },
        ...((v.saldoKasbon || 0) !== 0 ? [{ 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Piutang Karyawan (Kasbon)', 'Saldo (Rp)': v.saldoKasbon }] : []),
        ...((v.piutangDivisiKandang || 0) !== 0 ? [{ 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Piutang Antar-Divisi (Kandang Sendiri)', 'Saldo (Rp)': v.piutangDivisiKandang }] : []),
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Persediaan Pakan di Gudang (FIFO)', 'Saldo (Rp)': v.saldoPersediaan },
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'TOTAL AKTIVA', 'Saldo (Rp)': v.totalAktiva },
        { 'Kelompok': '', 'Pos Akun': '', 'Saldo (Rp)': '' },
        { 'Kelompok': 'PASIVA (KEWAJIBAN)', 'Pos Akun': 'Hutang Usaha Supplier Pakan', 'Saldo (Rp)': v.saldoHutang },
        { 'Kelompok': 'PASIVA (KEWAJIBAN)', 'Pos Akun': 'Hutang Upah Giling', 'Saldo (Rp)': v.saldoHutangUpahGiling || 0 },
        { 'Kelompok': 'PASIVA (KEWAJIBAN)', 'Pos Akun': 'TOTAL KEWAJIBAN', 'Saldo (Rp)': v.totalKewajiban },
        { 'Kelompok': '', 'Pos Akun': '', 'Saldo (Rp)': '' },
        { 'Kelompok': 'PASIVA (EKUITAS)', 'Pos Akun': v.modalLabel, 'Saldo (Rp)': v.ekuitasModal },
        { 'Kelompok': 'PASIVA (EKUITAS)', 'Pos Akun': v.hasPriorYearCutoff ? `Laba Bersih Penjualan Komersial (${v.tahunDipilih})` : 'Laba Bersih Penjualan Komersial', 'Saldo (Rp)': v.labaKomersialKumulatif || 0 },
        ...((v.potonganPrive || 0) !== 0 ? [{ 'Kelompok': 'PASIVA (EKUITAS)', 'Pos Akun': v.priveLabel, 'Saldo (Rp)': -(v.potonganPrive || 0) }] : []),
        { 'Kelompok': 'PASIVA (EKUITAS)', 'Pos Akun': 'TOTAL EKUITAS', 'Saldo (Rp)': v.totalEkuitas },
        { 'Kelompok': '', 'Pos Akun': '', 'Saldo (Rp)': '' },
        { 'Kelompok': 'PASIVA TOTAL', 'Pos Akun': 'TOTAL PASIVA (KEWAJIBAN + EKUITAS)', 'Saldo (Rp)': v.totalPasiva }
    ];

    if (fmt === 'xlsx' && typeof XLSX !== 'undefined') {
        let wb = XLSX.utils.book_new();
        let ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 22 }, { wch: 38 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, ws, "Neraca");
        XLSX.writeFile(wb, `${filename}.xlsx`);
    } else {
        let csvHeader = Object.keys(rows[0]).join(";");
        let csvBody = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
        let csv = "\uFEFFsep=;\r\n" + csvHeader + "\r\n" + csvBody;
        let blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${filename}.csv`;
        a.click();
    }
}


// =========================================================================
// EXPORT PDF FORMAL BERLOGO CBL
// =========================================================================

function cetakPdfLabaRugi(lr, filename, showKonsolidasi = false) {
    let nf = new Intl.NumberFormat('id-ID');
    let activeSementaraCount = showKonsolidasi ? (lr.countHppSementara || 0) : (lr.countHppSementaraKomersial || 0);

    let activeBranches = Object.values(lr.pemakaianKandangPerCabang || {}).filter(b => Object.keys(b.items).length > 0);
    let pemakaianRowsHtml = "";
    if (showKonsolidasi && activeBranches.length > 0) {
        activeBranches.forEach(branch => {
            let branchSelisih = branch.totalJual - branch.totalHpp;
            pemakaianRowsHtml += `
                <tr style="background:#f8fafc; font-weight:bold; font-size:9.5px; border-top:1px solid #94a3b8; border-bottom:1px solid #cbd5e1;">
                    <td colspan="5" style="padding:5px 6px; color:#0f172a;">${escapeHtmlKP(branch.label)}</td>
                </tr>
            `;
            Object.values(branch.items).sort((a, b) => b.totalHpp - a.totalHpp).forEach(u => {
                let selisih = u.totalJual - u.totalHpp;
                pemakaianRowsHtml += `
                    <tr style="border-bottom:1px solid #e2e8f0; font-size:9px;">
                        <td style="padding:4px 6px 4px 16px; color:#1e293b;">${escapeHtmlKP(u.unit)}</td>
                        <td style="padding:4px 6px; text-align:right;">${nf.format(u.totalQty)} Kg</td>
                        <td style="padding:4px 6px; text-align:right; font-weight:${u.hasEstimasi ? 'bold' : 'normal'}; color:${u.hasEstimasi ? '#2563eb' : '#0f172a'};">
                            Rp ${nf.format(u.totalHpp)}${u.hasEstimasi ? ' *' : ''}
                        </td>
                        <td style="padding:4px 6px; text-align:right; color:#334155;">Rp ${nf.format(u.totalJual)}</td>
                        <td style="padding:4px 6px; text-align:right; color:#0f172a;">+Rp ${nf.format(selisih)}</td>
                    </tr>
                `;
            });
            pemakaianRowsHtml += `
                <tr style="background:#f8fafc; font-weight:bold; font-size:9px; border-bottom:1px solid #94a3b8;">
                    <td style="padding:4px 6px 4px 12px; color:#475569;">Subtotal ${escapeHtmlKP(branch.label)}</td>
                    <td style="padding:4px 6px; text-align:right;">${nf.format(branch.totalQty)} Kg</td>
                    <td style="padding:4px 6px; text-align:right;">Rp ${nf.format(branch.totalHpp)}</td>
                    <td style="padding:4px 6px; text-align:right;">Rp ${nf.format(branch.totalJual)}</td>
                    <td style="padding:4px 6px; text-align:right;">+Rp ${nf.format(branchSelisih)}</td>
                </tr>
            `;
        });
    }

    let bebanRowsHtml = "";
    Object.keys(lr.bebanOperasionalMap).sort().forEach(kat => {
        bebanRowsHtml += `
            <tr>
                <td style="padding:3px 6px 3px 16px; font-size:9.5px; color:#334155;">${escapeHtmlKP(kat)}</td>
                <td style="padding:3px 6px; text-align:right; font-size:9.5px; color:#0f172a;">Rp ${nf.format(lr.bebanOperasionalMap[kat])}</td>
            </tr>
        `;
    });

    let el = document.createElement('div');
    el.style.width = '100%';
    el.style.maxWidth = '670px';
    el.style.boxSizing = 'border-box';
    el.style.padding = '12px 14px';
    el.style.background = '#ffffff';
    el.style.fontFamily = "Arial, Helvetica, sans-serif";
    el.style.color = '#0f172a';

    el.innerHTML = `
        <!-- KOP SURAT FORMAL -->
        <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:2px solid #1e3a8a; padding-bottom:8px; margin-bottom:12px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <img src="https://raw.githubusercontent.com/wildansyif/pakan-cbl/2e732398572a6ac7d3512559c4344d40ab0902f9/Logo%20CBL.png" style="height:42px; width:auto;" alt="Logo CBL" />
                <div>
                    <div style="font-size:14px; font-weight:bold; color:#1e3a8a; letter-spacing:0.4px;">PT. CITA BENGGALA LESTARI</div>
                    <div style="font-size:8.5px; color:#334155; font-weight:bold; margin-top:1px;">Unit Bisnis Logistik & Distribusi Pakan Ternak</div>
                    <div style="font-size:8px; color:#64748b;">Cikahuripan RT.04/RW.10, Kec. Lembang, Kab. Bandung Barat 40391</div>
                </div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:11px; font-weight:bold; color:#0f172a; text-transform:uppercase;">LAPORAN LABA RUGI</div>
                <div style="font-size:8.5px; color:#475569;">${showKonsolidasi ? 'Konsolidasian Holding' : 'Divisi Pakan (Standalone)'}</div>
                <div style="font-size:8.5px; color:#475569; margin-top:1px;">Periode: <b>${lr.periodeLabel}</b></div>
            </div>
        </div>

        ${activeSementaraCount > 0 ? `
        <div style="border:1px solid #bfdbfe; border-left:3px solid #2563eb; padding:6px 8px; margin-bottom:10px; font-size:8.5px; color:#1e40af; background:#f8fafc;">
            <b>Catatan (*) :</b> Angka bertanda <b>* warna biru</b> merupakan estimasi HPP sementara (<i>Menunggu input HPP</i>) yang akan otomatis terbarui saat nilai HPP riil diinput.
        </div>
        ` : ''}

        <!-- TABEL UTAMA LABA RUGI FORMAL -->
        <table style="width:100%; border-collapse:collapse; margin-bottom:12px;">
            <tbody>
                <!-- I. PENDAPATAN -->
                <tr>
                    <td colspan="2" style="padding:5px 6px; font-size:10px; font-weight:bold; color:#1e3a8a; border-bottom:1px solid #94a3b8; background:#f8fafc;">
                        I. PENDAPATAN OPERASIONAL KOMERSIAL
                    </td>
                </tr>
                <tr>
                    <td style="padding:3px 6px 3px 16px; font-size:9.5px;">Pendapatan Penjualan Pakan (Komersial)</td>
                    <td style="padding:3px 6px; text-align:right; font-size:9.5px; width:160px;">Rp ${nf.format(lr.revPenjualanPakan)}</td>
                </tr>
                <tr>
                    <td style="padding:3px 6px 3px 16px; font-size:9.5px;">Pendapatan Jasa Ongkir / Ekspedisi</td>
                    <td style="padding:3px 6px; text-align:right; font-size:9.5px;">Rp ${nf.format(lr.revJasaOngkir)}</td>
                </tr>
                ${lr.revRetur > 0 ? `
                <tr>
                    <td style="padding:3px 6px 3px 16px; font-size:9.5px;">Retur Penjualan</td>
                    <td style="padding:3px 6px; text-align:right; font-size:9.5px;">(Rp ${nf.format(lr.revRetur)})</td>
                </tr>` : ''}
                ${lr.revDiskon > 0 ? `
                <tr>
                    <td style="padding:3px 6px 3px 16px; font-size:9.5px;">Potongan & Diskon Penjualan</td>
                    <td style="padding:3px 6px; text-align:right; font-size:9.5px;">(Rp ${nf.format(lr.revDiskon)})</td>
                </tr>` : ''}
                <tr>
                    <td style="padding:5px 6px; font-size:9.5px; font-weight:bold; border-top:1px solid #cbd5e1; border-bottom:1px solid #94a3b8;">TOTAL PENDAPATAN BERSIH (NET SALES)</td>
                    <td style="padding:5px 6px; text-align:right; font-size:9.5px; font-weight:bold; border-top:1px solid #cbd5e1; border-bottom:1px solid #94a3b8;">Rp ${nf.format(lr.netSalesKomersial)}</td>
                </tr>

                <!-- II. HPP -->
                <tr>
                    <td colspan="2" style="padding:8px 6px 4px 6px; font-size:10px; font-weight:bold; color:#1e3a8a; border-bottom:1px solid #94a3b8; background:#f8fafc;">
                        II. HARGA POKOK PENJUALAN (HPP FIFO)
                    </td>
                </tr>
                <tr>
                    <td style="padding:4px 6px 4px 16px; font-size:9.5px;">Beban Pokok Penjualan Pakan Komersial${lr.cogsHasEstimasi ? ' <span style="color:#2563eb; font-weight:bold;">(*Sementara)</span>' : ''}</td>
                    <td style="padding:4px 6px; text-align:right; font-size:9.5px; font-weight:${lr.cogsHasEstimasi ? 'bold' : 'normal'}; color:${lr.cogsHasEstimasi ? '#2563eb' : '#0f172a'};">(Rp ${nf.format(lr.cogsPakanKomersial)})${lr.cogsHasEstimasi ? ' *' : ''}</td>
                </tr>
                <tr>
                    <td style="padding:5px 6px; font-size:10px; font-weight:bold; border-top:1px solid #94a3b8; border-bottom:1px solid #94a3b8; background:#f8fafc;">LABA KOTOR KOMERSIAL (GROSS PROFIT — ${lr.grossMarginKomersial}%)</td>
                    <td style="padding:5px 6px; text-align:right; font-size:10px; font-weight:bold; border-top:1px solid #94a3b8; border-bottom:1px solid #94a3b8; background:#f8fafc;">Rp ${nf.format(lr.grossProfitKomersial)}</td>
                </tr>

                <!-- III. BEBAN OPERASIONAL -->
                <tr>
                    <td colspan="2" style="padding:8px 6px 4px 6px; font-size:10px; font-weight:bold; color:#1e3a8a; border-bottom:1px solid #94a3b8; background:#f8fafc;">
                        III. BEBAN OPERASIONAL GUDANG & LAPANGAN
                    </td>
                </tr>
                ${bebanRowsHtml || '<tr><td colspan="2" style="padding:4px 16px; font-size:9px; color:#64748b;">Tidak ada data beban operasional.</td></tr>'}
                <tr>
                    <td style="padding:5px 6px; font-size:9.5px; font-weight:bold; border-top:1px solid #cbd5e1;">TOTAL BEBAN OPERASIONAL GUDANG</td>
                    <td style="padding:5px 6px; text-align:right; font-size:9.5px; font-weight:bold; border-top:1px solid #cbd5e1;">(Rp ${nf.format(lr.totalBebanOperasionalGudang)})</td>
                </tr>

                <!-- LABA BERSIH DIVISI PAKAN -->
                <tr>
                    <td style="padding:7px 6px; font-size:10.5px; font-weight:bold; border-top:1.5px solid #0f172a; border-bottom:3px double #0f172a; background:#f8fafc;">
                        LABA BERSIH OPERASIONAL DIVISI PAKAN (${lr.netMarginDivisiPakan}%)
                    </td>
                    <td style="padding:7px 6px; text-align:right; font-size:10.5px; font-weight:bold; border-top:1.5px solid #0f172a; border-bottom:3px double #0f172a; background:#f8fafc;">
                        Rp ${nf.format(lr.labaBersihDivisiPakan)}
                    </td>
                </tr>
            </tbody>
        </table>

        ${showKonsolidasi ? `
        <div style="margin-top:10px; margin-bottom:10px; page-break-inside:avoid;">
            <div style="font-weight:bold; font-size:10px; color:#1e3a8a; border-bottom:1px solid #94a3b8; padding:4px 6px; background:#f8fafc; margin-bottom:4px;">
                IV. ALOKASI KONSUMSI PAKAN TERNAK SENDIRI (HOLDING INTERNAL)
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:9px; border:1px solid #cbd5e1;">
                <thead>
                    <tr style="background:#f1f5f9; border-bottom:1px solid #94a3b8;">
                        <th style="padding:4px 6px; text-align:left;">Cabang / Unit Ternak</th>
                        <th style="padding:4px 6px; text-align:right;">Total Qty (Kg)</th>
                        <th style="padding:4px 6px; text-align:right;">Modal (HPP FIFO)</th>
                        <th style="padding:4px 6px; text-align:right;">Harga Jual Normal</th>
                        <th style="padding:4px 6px; text-align:right;">Selisih (Subsidi)</th>
                    </tr>
                </thead>
                <tbody>
                    ${pemakaianRowsHtml || '<tr><td colspan="5" style="padding:6px; text-align:center; color:#64748b;">Tidak ada pemakaian internal.</td></tr>'}
                </tbody>
                <tfoot>
                    <tr style="background:#f8fafc; font-weight:bold; border-top:1.5px solid #0f172a; border-bottom:1.5px solid #0f172a; font-size:9px;">
                        <td style="padding:5px 6px;">TOTAL ALOKASI INTERNAL</td>
                        <td style="padding:5px 6px; text-align:right;">${nf.format(lr.totalPemakaianQty)} Kg</td>
                        <td style="padding:5px 6px; text-align:right;">Rp ${nf.format(lr.totalPemakaianHpp)}</td>
                        <td style="padding:5px 6px; text-align:right;">Rp ${nf.format(lr.totalPemakaianJual)}</td>
                        <td style="padding:5px 6px; text-align:right;">+Rp ${nf.format(lr.totalSubsidiInternal)}</td>
                    </tr>
                </tfoot>
            </table>
        </div>

        <table style="width:100%; border-collapse:collapse; margin-bottom:12px;">
            <tr>
                <td style="padding:6px 6px; font-size:10.5px; font-weight:bold; border-top:1.5px solid #0f172a; border-bottom:3px double #0f172a; background:#f8fafc;">
                    V. HASIL BERSIH KONSOLIDASIAN HOLDING
                </td>
                <td style="padding:6px 6px; text-align:right; font-size:10.5px; font-weight:bold; border-top:1.5px solid #0f172a; border-bottom:3px double #0f172a; background:#f8fafc; width:160px;">
                    Rp ${nf.format(lr.labaBersihKonsolidasian)}
                </td>
            </tr>
        </table>
        ` : ''}

        <!-- TANDA TANGAN FORMAL -->
        <div style="margin-top:28px; display:flex; justify-content:space-between; text-align:center; font-size:9px; color:#1e293b; page-break-inside:avoid;">
            <div style="width:30%;">
                <div>Dibuat Oleh,</div>
                <div style="margin-top:42px; font-weight:bold; border-bottom:1px solid #0f172a; display:inline-block; min-width:125px;">( Staf Keuangan & Akuntansi )</div>
                <div style="font-size:8px; color:#64748b; margin-top:2px;">Divisi Keuangan PT CBL</div>
            </div>
            <div style="width:30%;">
                <div>Diperiksa Oleh,</div>
                <div style="margin-top:42px; font-weight:bold; border-bottom:1px solid #0f172a; display:inline-block; min-width:125px;">( Manajer Operasional )</div>
                <div style="font-size:8px; color:#64748b; margin-top:2px;">Logistik & Pengadaan Pakan</div>
            </div>
            <div style="width:30%;">
                <div>Disetujui Oleh,</div>
                <div style="margin-top:42px; font-weight:bold; border-bottom:1px solid #0f172a; display:inline-block; min-width:125px;">( Direktur Utama )</div>
                <div style="font-size:8px; color:#64748b; margin-top:2px;">PT. CITA BENGGALA LESTARI</div>
            </div>
        </div>
    `;

    document.body.appendChild(el);
    let opt = {
        margin: [8, 8, 8, 8],
        filename: `${filename}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    if (typeof html2pdf !== 'undefined') {
        html2pdf().set(opt).from(el).save().then(() => {
            document.body.removeChild(el);
        }).catch(err => {
            console.error("Gagal cetak PDF LR:", err);
            document.body.removeChild(el);
            alert("Terjadi kendala saat membuat file PDF: " + err.message);
        });
    } else {
        alert("Library html2pdf belum tersedia. Silakan gunakan opsi cetak browser.");
        document.body.removeChild(el);
    }
}

function cetakPdfNeraca(n, filename) {
    let v = getNeracaViewModel(n);
    let nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
    let isBalance = Math.abs(v.selisih) <= 2;

    let el = document.createElement('div');
    el.style.width = '100%';
    el.style.maxWidth = '670px';
    el.style.boxSizing = 'border-box';
    el.style.padding = '12px 14px';
    el.style.background = '#ffffff';
    el.style.fontFamily = "Arial, Helvetica, sans-serif";
    el.style.color = '#0f172a';

    el.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:2px solid #1e3a8a; padding-bottom:8px; margin-bottom:12px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <img src="https://raw.githubusercontent.com/wildansyif/pakan-cbl/2e732398572a6ac7d3512559c4344d40ab0902f9/Logo%20CBL.png" style="height:42px; width:auto;" alt="Logo CBL" />
                <div>
                    <div style="font-size:14px; font-weight:bold; color:#1e3a8a; letter-spacing:0.4px;">PT. CITA BENGGALA LESTARI</div>
                    <div style="font-size:8.5px; color:#334155; font-weight:bold; margin-top:1px;">Unit Bisnis Logistik & Distribusi Pakan Ternak</div>
                    <div style="font-size:8px; color:#64748b;">Cikahuripan RT.04/RW.10, Kec. Lembang, Kab. Bandung Barat 40391</div>
                </div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:11px; font-weight:bold; color:#0f172a; text-transform:uppercase;">LAPORAN POSISI KEUANGAN (NERACA)</div>
                <div style="font-size:8.5px; color:#475569;">${v.showPrive ? 'Konsolidasian (Mode Prive Internal)' : 'Divisi Pakan (Komersial Mandiri)'}</div>
                <div style="font-size:8.5px; color:#475569; margin-top:1px;">Posisi Per: <b>${v.asOfLabel}</b></div>
            </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; border:1px solid #cbd5e1; border-left:3px solid ${isBalance ? '#1e3a8a' : '#64748b'}; background:#f8fafc; margin-bottom:12px; font-size:9.5px; font-weight:bold;">
            <span>${isBalance ? 'STATUS: NERACA 100% BALANCE (AKTIVA = PASIVA)' : 'STATUS: TERDAPAT REKONSILIASI FISIK GUDANG'}</span>
            <span>Selisih: Rp ${nf.format(Math.abs(v.selisih) <= 2 ? 0 : v.selisih)}</span>
        </div>

        <table style="width:100%; border-collapse:collapse; margin-bottom:18px; table-layout:fixed;">
            <thead>
                <tr style="background:#f1f5f9; border-top:1.5px solid #0f172a; border-bottom:1px solid #94a3b8; font-size:10px;">
                    <th style="padding:6px 8px; text-align:left; width:50%; border-right:1px solid #cbd5e1; color:#1e3a8a;">AKTIVA (ASET)</th>
                    <th style="padding:6px 8px; text-align:left; width:50%; color:#1e3a8a;">PASIVA (KEWAJIBAN & EKUITAS)</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td style="vertical-align:top; padding:8px; border-right:1px solid #cbd5e1; border-bottom:1px solid #cbd5e1;">
                        <div style="font-weight:bold; font-size:9.5px; color:#334155; margin-bottom:4px;">Aset Lancar:</div>
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9;">
                            <span>• Kas & Bank</span>
                            <span>Rp ${nf.format(v.saldoKas)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9;">
                            <span>• Piutang Pakan Peternak</span>
                            <span>Rp ${nf.format(v.saldoPiutang)}</span>
                        </div>
                        ${(v.saldoKasbon || 0) !== 0 ? `
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9;">
                            <span>• Piutang Karyawan (Kasbon)</span>
                            <span>Rp ${nf.format(v.saldoKasbon)}</span>
                        </div>
                        ` : ''}
                        ${(v.piutangDivisiKandang || 0) !== 0 ? `
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9; color:#0369a1;">
                            <span>• Piutang Antar-Divisi (Kandang Sendiri)</span>
                            <span>Rp ${nf.format(v.piutangDivisiKandang)}</span>
                        </div>
                        ` : ''}
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9;">
                            <span>• Persediaan Pakan di Gudang</span>
                            <span>Rp ${nf.format(v.saldoPersediaan)}</span>
                        </div>
                    </td>
                    <td style="vertical-align:top; padding:8px; border-bottom:1px solid #cbd5e1;">
                        <div style="font-weight:bold; font-size:9.5px; color:#334155; margin-bottom:4px;">I. Kewajiban:</div>
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9;">
                            <span>• Hutang Usaha Supplier Pakan</span>
                            <span>Rp ${nf.format(v.saldoHutang)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9;">
                            <span>• Hutang Upah Giling</span>
                            <span>Rp ${nf.format(v.saldoHutangUpahGiling || 0)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9px; font-weight:bold; color:#475569; margin-bottom:8px;">
                            <span>Total Kewajiban</span>
                            <span>Rp ${nf.format(v.totalKewajiban)}</span>
                        </div>

                        <div style="font-weight:bold; font-size:9.5px; color:#334155; margin-bottom:4px;">II. Ekuitas:</div>
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9;">
                            <span>• ${v.modalLabel}</span>
                            <span>Rp ${nf.format(v.ekuitasModal)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9; color:${(v.labaKomersialKumulatif || 0) >= 0 ? '#15803d' : '#b91c1c'};">
                            <span>• ${v.hasPriorYearCutoff ? `Laba Bersih Penjualan Komersial (${v.tahunDipilih})` : 'Laba Bersih Penjualan Komersial'}</span>
                            <span>${(v.labaKomersialKumulatif || 0) >= 0 ? '+' : ''}Rp ${nf.format(v.labaKomersialKumulatif || 0)}</span>
                        </div>
                        ${(v.potonganPrive || 0) !== 0 ? `
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9.5px; border-bottom:1px solid #f1f5f9; color:#475569;">
                            <span>• ${v.priveLabel}</span>
                            <span>(Rp ${nf.format(v.potonganPrive)})</span>
                        </div>
                        ` : ''}
                        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:9px; font-weight:bold; color:#475569;">
                            <span>Total Ekuitas</span>
                            <span>Rp ${nf.format(v.totalEkuitas)}</span>
                        </div>
                    </td>
                </tr>
                <tr style="background:#f8fafc; font-weight:bold; font-size:10px; border-top:1.5px solid #0f172a; border-bottom:3px double #0f172a;">
                    <td style="padding:7px 8px; border-right:1px solid #cbd5e1;">
                        <div style="display:flex; justify-content:space-between;">
                            <span>TOTAL AKTIVA</span>
                            <span>Rp ${nf.format(v.totalAktiva)}</span>
                        </div>
                    </td>
                    <td style="padding:7px 8px;">
                        <div style="display:flex; justify-content:space-between;">
                            <span>TOTAL PASIVA</span>
                            <span>Rp ${nf.format(v.totalPasiva)}</span>
                        </div>
                    </td>
                </tr>
            </tbody>
        </table>

        <div style="margin-top:30px; display:flex; justify-content:space-between; text-align:center; font-size:9px; color:#1e293b; page-break-inside:avoid;">
            <div style="width:30%;">
                <div>Dibuat Oleh,</div>
                <div style="margin-top:42px; font-weight:bold; border-bottom:1px solid #0f172a; display:inline-block; min-width:125px;">( Staf Keuangan & Akuntansi )</div>
                <div style="font-size:8px; color:#64748b; margin-top:2px;">Divisi Keuangan PT CBL</div>
            </div>
            <div style="width:30%;">
                <div>Diperiksa Oleh,</div>
                <div style="margin-top:42px; font-weight:bold; border-bottom:1px solid #0f172a; display:inline-block; min-width:125px;">( Manajer Operasional )</div>
                <div style="font-size:8px; color:#64748b; margin-top:2px;">Logistik & Pengadaan Pakan</div>
            </div>
            <div style="width:30%;">
                <div>Disetujui Oleh,</div>
                <div style="margin-top:42px; font-weight:bold; border-bottom:1px solid #0f172a; display:inline-block; min-width:125px;">( Direktur Utama )</div>
                <div style="font-size:8px; color:#64748b; margin-top:2px;">PT. CITA BENGGALA LESTARI</div>
            </div>
        </div>
    `;

    document.body.appendChild(el);
    let opt = {
        margin: [8, 8, 8, 8],
        filename: `${filename}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    if (typeof html2pdf !== 'undefined') {
        html2pdf().set(opt).from(el).save().then(() => {
            document.body.removeChild(el);
        }).catch(err => {
            console.error("Gagal cetak PDF Neraca:", err);
            document.body.removeChild(el);
            alert("Terjadi kendala saat membuat file PDF: " + err.message);
        });
    } else {
        alert("Library html2pdf belum tersedia. Silakan gunakan opsi cetak browser.");
        document.body.removeChild(el);
    }
}


// =========================================================================
// EXPOSE GLOBAL WINDOW FUNCTIONS
// =========================================================================

window.switchTabJurnal = switchTabJurnal;

window.fetchDataMentah = fetchDataMentah;
window.renderDataMentah = renderDataMentah;
window.bukaModalKoreksiMentah = bukaModalKoreksiMentah;
window.tutupModalKoreksiMentah = tutupModalKoreksiMentah;
window.simpanKoreksiMentah = simpanKoreksiMentah;
window.toggleDropdownExportMentah = toggleDropdownExportMentah;
window.exportDataMentah = exportDataMentah;

window.switchSubTabHPP = switchSubTabHPP;
window.fetchTrackingHPP = fetchTrackingHPP;
window.renderTrackingHPP = renderTrackingHPP;
window.toggleDropdownExportHPP = toggleDropdownExportHPP;
window.exportTrackingHPP = exportTrackingHPP;

window.muatLabaRugi = muatLabaRugi;
window.renderLabaRugi = renderLabaRugi;
window.toggleDropdownExportLR = toggleDropdownExportLR;
window.exportLabaRugi = exportLabaRugi;

window.muatNeraca = muatNeraca;
window.renderNeraca = renderNeraca;
window.toggleDropdownExportNeraca = toggleDropdownExportNeraca;
window.exportNeraca = exportNeraca;

window.toggleHeaderFilter = toggleHeaderFilter;
window.renderHeaderCheckboxList = renderHeaderCheckboxList;
window.filterHeaderCheckboxList = filterHeaderCheckboxList;
window.onToggleHeaderItem = onToggleHeaderItem;
window.selectAllHeaderFilter = selectAllHeaderFilter;
window.applyHeaderFilter = applyHeaderFilter;
window.closeHeaderFilter = closeHeaderFilter;
window.updateHeaderFilterIcons = updateHeaderFilterIcons;
window.changePageBatch = changePageBatch;
window.getBatchStatus = getBatchStatus;
window.cetakPdfLabaRugi = cetakPdfLabaRugi;
window.cetakPdfNeraca = cetakPdfNeraca;
window.formatDetailPotonganNota = formatDetailPotonganNota;
