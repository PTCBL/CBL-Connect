// ==============================================================================
// MODUL KAS BAPERA (pakan-cbl)
// Manajemen Rekapitulasi Kas & Arus Kas Operasional BAPERA (Gudang PM)
// ==============================================================================

let baperaCurrentYear = new Date().getFullYear();
let baperaSalesRaw = [];
let baperaCashflowRaw = [];
let baperaMonthlySummary = [];
let baperaYearlySummary = [];
let baperaFeedSummary = {};
let baperaCategorySummary = { masuk: {}, keluar: {} };
let baperaSaldoAwalTahun = 0;
let baperaSaldoAkhirTahun = 0;
let baperaFileBuktiBase64 = null;
let baperaFileBuktiMime = null;

// Baseline historis dari Spreadsheet yang sudah diaudit dan ditutup
const BAPERA_HISTORIS_2025 = {
    saldoAwal2024: 386000,
    totalKg: { 'Mako A-20': 262976, 'Mako S-20': 373750, 'Mako C-20': 0, 'Pongkol Singkong': 73868, 'Silase Jagung Manis': 0 },
    sharingPakanRp: 14211880,
    debitRp: 850000,
    kreditRp: 6038000,
    netKas2025: 9023880,
    saldoAkhir2025: 9409880
};

// -----------------------------------------------------------------------------
// 1. Inisialisasi Modul
// -----------------------------------------------------------------------------
function initModulBapera() {
    let selectTahun = document.getElementById('bapera-filter-tahun');
    if (selectTahun && selectTahun.options.length === 0) {
        let tahunNow = new Date().getFullYear();
        
        // 1. Opsi Tahun Sekarang (Default Selected)
        let optNow = document.createElement('option');
        optNow.value = tahunNow;
        optNow.textContent = `Tahun Buku ${tahunNow}`;
        optNow.selected = true;
        selectTahun.appendChild(optNow);

        // 2. Opsi Semua Tahun (Rekap Lengkap Kumulatif)
        let optAll = document.createElement('option');
        optAll.value = 'ALL';
        optAll.textContent = `Semua Tahun (Rekap Lengkap)`;
        selectTahun.appendChild(optAll);

        // 3. Opsi Tahun-tahun Sebelumnya
        for (let y = tahunNow - 1; y >= 2025; y--) {
            let opt = document.createElement('option');
            opt.value = y;
            opt.textContent = `Tahun Buku ${y}`;
            selectTahun.appendChild(opt);
        }
        baperaCurrentYear = tahunNow;
    } else if (selectTahun) {
        let val = selectTahun.value;
        baperaCurrentYear = (val === 'ALL') ? 'ALL' : (parseInt(val) || new Date().getFullYear());
    }

    fetchDataBapera(baperaCurrentYear);
}

function gantiTahunBapera() {
    let selectTahun = document.getElementById('bapera-filter-tahun');
    if (selectTahun) {
        let val = selectTahun.value;
        baperaCurrentYear = (val === 'ALL') ? 'ALL' : (parseInt(val) || new Date().getFullYear());
        fetchDataBapera(baperaCurrentYear);
    }
}

// -----------------------------------------------------------------------------
// 2. Fetch Data dari Supabase (transaksi_pakan & cashflow)
// -----------------------------------------------------------------------------
async function fetchDataBapera(tahun, silent = false) {
    if (!silent) {
        let loader = document.getElementById('bapera-loader');
        if (loader) loader.classList.remove('hidden');
    }

    let isAll = (tahun === 'ALL');
    let startDate = isAll ? '2026-01-01' : `${tahun}-01-01`;
    let endDate = isAll ? '2099-12-31' : `${tahun}-12-31`;

    try {
        let fnFetch = (typeof fetchSupabaseAll === 'function') ? fetchSupabaseAll : null;

        // Tarik data Penjualan Pakan di Gudang PM
        let urlSales = `${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=gte.${startDate}&tanggal=lte.${endDate}&cabang=eq.PM&status=ilike.*keluar*&select=tanggal,waktu_input,cabang,status,relasi,pakan,qty,satuan,catatan&order=tanggal.asc`;
        
        // Tarik seluruh cashflow BAPERA (semua tahun untuk rekonsiliasi yang komprehensif)
        let urlCF = `${SUPA_URL}/rest/v1/cashflow?relasi=ilike.*BAPERA*&order=tanggal.asc,id.asc`;

        let [salesRes, cfRes] = await Promise.all([
            fnFetch ? fnFetch(urlSales) : fetch(urlSales, { headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` } }).then(r => r.json()),
            fnFetch ? fnFetch(urlCF) : fetch(urlCF, { headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` } }).then(r => r.json())
        ]);

        baperaSalesRaw = Array.isArray(salesRes) ? salesRes : [];
        baperaCashflowRaw = Array.isArray(cfRes) ? cfRes : [];

        // Hitung dan proses kalkulasi
        kalkulasiDataBapera(tahun);

        // Render ke UI
        renderBaperaCards();
        renderBaperaTabelRekap();
        renderBaperaTabelMutasi();

    } catch (e) {
        console.error("Gagal memuat data Kas BAPERA:", e);
        alert("Gagal memuat data Kas BAPERA dari server: " + e.message);
    } finally {
        let loader = document.getElementById('bapera-loader');
        if (loader) loader.classList.add('hidden');
    }
}

// -----------------------------------------------------------------------------
// 3. Mesin Filter & Kalkulasi Logika Bisnis BAPERA
// -----------------------------------------------------------------------------
function isPenjualanMurniPM(row) {
    let cabangLower = String(row.cabang || '').toLowerCase().trim();
    if (cabangLower !== 'pm') return false;

    let statusLower = String(row.status || '').toLowerCase().trim();
    if (statusLower.includes('masuk')) return false;

    let relasiLower = String(row.relasi || '').toLowerCase().trim();
    let catatanLower = String(row.catatan || '').toLowerCase().trim();

    // 1. Filter Giling Ransum
    if (relasiLower.includes("rd") || relasiLower.includes("rl") || relasiLower.includes("darbun") || relasiLower.includes("laktasi")) {
        return false;
    }
    // 2. Filter Pemakaian Internal Kandang
    if (cabangLower.includes('kandang') || relasiLower.includes("kandang") || 
        relasiLower.includes('kapalang') || relasiLower.includes('dewasa') || 
        relasiLower.includes('jantan') || relasiLower.includes('pedet') || 
        relasiLower.includes('kerbau') || relasiLower.includes('bunting') ||
        relasiLower.includes('bx') || relasiLower.includes('domba') ||
        relasiLower.includes('cibulakan')) {
        return false;
    }
    // 3. Filter Mutasi Antar Gudang
    if (relasiLower.includes("rph") || relasiLower.includes("spn") || relasiLower.includes("pembibitan") || catatanLower.includes("mutasi")) {
        return false;
    }

    return true;
}

function getPakanSharingInfo(pakanRaw) {
    let p = String(pakanRaw || '').trim().toLowerCase();
    
    // Mako A-20 -> Rp 20 / kg
    if (p.includes('mako a-20') || p.includes('mako a20') || p === 'a20' || p === 'mako a') {
        return { key: 'Mako A-20', tarif: 20 };
    }
    // Mako S-20 -> Rp 20 / kg
    if (p.includes('mako s-20') || p.includes('mako s20') || p === 's20' || p === 'mako s') {
        return { key: 'Mako S-20', tarif: 20 };
    }
    // Mako C-20 -> Rp 20 / kg
    if (p.includes('mako c-20') || p.includes('mako c20') || p === 'c20' || p === 'mako c') {
        return { key: 'Mako C-20', tarif: 20 };
    }
    // Pongkol Singkong -> Rp 20 / kg
    if (p.includes('pongkol') || p === 'ps') {
        return { key: 'Pongkol Singkong', tarif: 20 };
    }
    // Silase Jagung (Manis & Hybrid) -> Rp 10 / kg
    if (p.includes('silase jagung')) {
        return { key: 'Silase Jagung Manis', tarif: 10 };
    }

    return null;
}

function kalkulasiDataBapera(tahun) {
    // -------------------------------------------------------------------------
    // A. KALKULASI SEMUA TAHUN (KUMULATIF LENGKAP)
    // -------------------------------------------------------------------------
    if (tahun === 'ALL') {
        baperaSaldoAwalTahun = BAPERA_HISTORIS_2025.saldoAwal2024; // Rp 386.000 (Cut-off 31 Des 2024)

        // Reset feed summary kumulatif dengan baseline 2025
        baperaFeedSummary = {
            'Mako A-20': { kg: BAPERA_HISTORIS_2025.totalKg['Mako A-20'], tarif: 20, totalRp: BAPERA_HISTORIS_2025.totalKg['Mako A-20'] * 20 },
            'Mako S-20': { kg: BAPERA_HISTORIS_2025.totalKg['Mako S-20'], tarif: 20, totalRp: BAPERA_HISTORIS_2025.totalKg['Mako S-20'] * 20 },
            'Mako C-20': { kg: 0, tarif: 20, totalRp: 0 },
            'Pongkol Singkong': { kg: BAPERA_HISTORIS_2025.totalKg['Pongkol Singkong'], tarif: 20, totalRp: BAPERA_HISTORIS_2025.totalKg['Pongkol Singkong'] * 20 },
            'Silase Jagung Manis': { kg: 0, tarif: 10, totalRp: 0 }
        };

        // Olah penjualan pakan 2026 ke atas dari cloud
        let dynamicYearFeeds = {};
        baperaSalesRaw.forEach(row => {
            if (!isPenjualanMurniPM(row)) return;
            let infoPakan = getPakanSharingInfo(row.pakan);
            if (!infoPakan) return;

            let tgl = row.tanggal || '';
            // Silase Jagung mulai dihitung sharing BAPERA per Agustus 2026
            if (infoPakan.key === 'Silase Jagung Manis' && tgl < '2026-08-01') return;

            let y = parseInt(tgl.substring(0, 4));
            if (isNaN(y) || y < 2026) return;

            let qty = parseFloat(row.qty) || 0;
            let rupiahHak = qty * infoPakan.tarif;

            if (!dynamicYearFeeds[y]) {
                dynamicYearFeeds[y] = {
                    'Mako A-20': 0, 'Mako S-20': 0, 'Mako C-20': 0, 'Pongkol Singkong': 0, 'Silase Jagung Manis': 0,
                    totalKg: 0, sharingRp: 0
                };
            }
            dynamicYearFeeds[y][infoPakan.key] += qty;
            dynamicYearFeeds[y].totalKg += qty;
            dynamicYearFeeds[y].sharingRp += rupiahHak;

            baperaFeedSummary[infoPakan.key].kg += qty;
            baperaFeedSummary[infoPakan.key].totalRp += rupiahHak;
        });

        // Kategorisasi seluruh cashflow operasional
        baperaCategorySummary = { masuk: {}, keluar: {} };
        let dynamicYearCF = {};

        baperaCashflowRaw.forEach(cf => {
            let tgl = cf.tanggal || '';
            let y = parseInt(tgl.substring(0, 4));
            let nom = parseFloat(cf.nominal) || 0;
            let jenis = String(cf.jenis || '').toLowerCase();
            let kat = String(cf.kategori || 'Operasional Lainnya').trim();

            if (kat === 'Saldo Awal') return; // Saldo awal Des 2024 dihitung tersendiri

            if (jenis.includes('masuk') || jenis.includes('debit')) {
                baperaCategorySummary.masuk[kat] = (baperaCategorySummary.masuk[kat] || 0) + nom;
                if (!dynamicYearCF[y]) dynamicYearCF[y] = { debitRp: 0, kreditRp: 0 };
                dynamicYearCF[y].debitRp += nom;
            } else if (jenis.includes('keluar') || jenis.includes('kredit')) {
                baperaCategorySummary.keluar[kat] = (baperaCategorySummary.keluar[kat] || 0) + nom;
                if (!dynamicYearCF[y]) dynamicYearCF[y] = { debitRp: 0, kreditRp: 0 };
                dynamicYearCF[y].kreditRp += nom;
            }
        });

        // Susun Tabel Ringkasan Pertumbuhan Kas per Tahun (baperaYearlySummary)
        baperaYearlySummary = [];

        // 1. Tahun Buku 2025 (Baseline Sah Spreadsheet)
        baperaYearlySummary.push({
            tahun: 2025,
            label: 'Tahun Buku 2025',
            saldoAwal: BAPERA_HISTORIS_2025.saldoAwal2024,
            feeds: { ...BAPERA_HISTORIS_2025.totalKg },
            totalKgSharing: 710594,
            sharingRp: BAPERA_HISTORIS_2025.sharingPakanRp,
            debitRp: BAPERA_HISTORIS_2025.debitRp,
            kreditRp: BAPERA_HISTORIS_2025.kreditRp,
            netKas: BAPERA_HISTORIS_2025.netKas2025,
            saldoAkhir: BAPERA_HISTORIS_2025.saldoAkhir2025
        });

        // 2. Tahun Buku 2026 dst (Dihitung Dinamis dari Database Cloud)
        let runningSaldo = BAPERA_HISTORIS_2025.saldoAkhir2025;
        let allDynamicYears = Object.keys(dynamicYearFeeds).map(Number).sort((a,b)=>a-b);
        if (!allDynamicYears.includes(2026)) allDynamicYears.push(2026);

        allDynamicYears.forEach(y => {
            let feedData = dynamicYearFeeds[y] || {
                'Mako A-20': 0, 'Mako S-20': 0, 'Mako C-20': 0, 'Pongkol Singkong': 0, 'Silase Jagung Manis': 0,
                totalKg: 0, sharingRp: 0
            };
            let cfData = dynamicYearCF[y] || { debitRp: 0, kreditRp: 0 };
            let netKas = feedData.sharingRp + cfData.debitRp - cfData.kreditRp;
            let saldoAkhir = runningSaldo + netKas;

            baperaYearlySummary.push({
                tahun: y,
                label: `Tahun Buku ${y}`,
                saldoAwal: runningSaldo,
                feeds: {
                    'Mako A-20': feedData['Mako A-20'],
                    'Mako S-20': feedData['Mako S-20'],
                    'Mako C-20': feedData['Mako C-20'],
                    'Pongkol Singkong': feedData['Pongkol Singkong'],
                    'Silase Jagung Manis': feedData['Silase Jagung Manis']
                },
                totalKgSharing: feedData.totalKg,
                sharingRp: feedData.sharingRp,
                debitRp: cfData.debitRp,
                kreditRp: cfData.kreditRp,
                netKas: netKas,
                saldoAkhir: saldoAkhir
            });

            runningSaldo = saldoAkhir;
        });

        baperaSaldoAkhirTahun = runningSaldo;
        return;
    }

    // -------------------------------------------------------------------------
    // B. KALKULASI TAHUNAN TERTENTU (MISAL 2026)
    // -------------------------------------------------------------------------
    let cfSebelumTahunIni = baperaCashflowRaw.filter(cf => {
        let tgl = cf.tanggal || '';
        return tgl < `${tahun}-01-01`;
    });

    let netCfSebelum = 0;
    cfSebelumTahunIni.forEach(cf => {
        let nom = parseFloat(cf.nominal) || 0;
        let j = String(cf.jenis || '').toLowerCase();
        if (j.includes('masuk') || j.includes('debit')) netCfSebelum += nom;
        else if (j.includes('keluar') || j.includes('kredit')) netCfSebelum -= nom;
    });

    if (tahun === 2025) {
        baperaSaldoAwalTahun = netCfSebelum > 0 ? netCfSebelum : BAPERA_HISTORIS_2025.saldoAwal2024;
    } else if (tahun === 2026) {
        baperaSaldoAwalTahun = BAPERA_HISTORIS_2025.saldoAkhir2025;
    } else {
        baperaSaldoAwalTahun = netCfSebelum > 0 ? netCfSebelum : 0;
    }

    // Siapkan Rangkuman 12 Bulan
    baperaMonthlySummary = [];
    const namaBulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    
    for (let m = 0; m < 12; m++) {
        baperaMonthlySummary.push({
            bulanIdx: m,
            namaBulan: namaBulan[m],
            feeds: {
                'Mako A-20': 0,
                'Mako S-20': 0,
                'Mako C-20': 0,
                'Pongkol Singkong': 0,
                'Silase Jagung Manis': 0
            },
            totalKgSharing: 0,
            sharingRp: 0,
            debitRp: 0,
            kreditRp: 0,
            netKasBulan: 0,
            saldoAkumulatif: 0
        });
    }

    // Reset summary per pakan tahunan
    baperaFeedSummary = {
        'Mako A-20': { kg: 0, tarif: 20, totalRp: 0 },
        'Mako S-20': { kg: 0, tarif: 20, totalRp: 0 },
        'Mako C-20': { kg: 0, tarif: 20, totalRp: 0 },
        'Pongkol Singkong': { kg: 0, tarif: 20, totalRp: 0 },
        'Silase Jagung Manis': { kg: 0, tarif: 10, totalRp: 0 }
    };

    // Olah Penjualan Pakan Bulan Terkait
    baperaSalesRaw.forEach(row => {
        if (!isPenjualanMurniPM(row)) return;

        let infoPakan = getPakanSharingInfo(row.pakan);
        if (!infoPakan) return;

        let tgl = row.tanggal || '';
        // Silase Jagung mulai dihitung sharing BAPERA per Agustus 2026
        if (infoPakan.key === 'Silase Jagung Manis' && tgl < '2026-08-01') {
            return;
        }

        let d = new Date(tgl);
        let mIdx = d.getMonth();
        if (isNaN(mIdx) || mIdx < 0 || mIdx > 11) return;

        let qty = parseFloat(row.qty) || 0;
        let rupiahHak = qty * infoPakan.tarif;

        baperaMonthlySummary[mIdx].feeds[infoPakan.key] += qty;
        baperaMonthlySummary[mIdx].totalKgSharing += qty;
        baperaMonthlySummary[mIdx].sharingRp += rupiahHak;

        baperaFeedSummary[infoPakan.key].kg += qty;
        baperaFeedSummary[infoPakan.key].totalRp += rupiahHak;
    });

    // Olah Cashflow BAPERA Tahun Ini
    baperaCategorySummary = { masuk: {}, keluar: {} };
    let cfTahunIni = baperaCashflowRaw.filter(cf => {
        let tgl = cf.tanggal || '';
        return tgl >= `${tahun}-01-01` && tgl <= `${tahun}-12-31`;
    });

    cfTahunIni.forEach(cf => {
        let tgl = cf.tanggal || '';
        let d = new Date(tgl);
        let mIdx = d.getMonth();
        let nom = parseFloat(cf.nominal) || 0;
        let jenis = String(cf.jenis || '').toLowerCase();
        let kat = String(cf.kategori || 'Operasional Lainnya').trim();

        if (kat === 'Saldo Awal') return;

        if (mIdx >= 0 && mIdx <= 11) {
            if (jenis.includes('masuk') || jenis.includes('debit')) {
                baperaMonthlySummary[mIdx].debitRp += nom;
                baperaCategorySummary.masuk[kat] = (baperaCategorySummary.masuk[kat] || 0) + nom;
            } else if (jenis.includes('keluar') || jenis.includes('kredit')) {
                baperaMonthlySummary[mIdx].kreditRp += nom;
                baperaCategorySummary.keluar[kat] = (baperaCategorySummary.keluar[kat] || 0) + nom;
            }
        }
    });

    // Hitung Running Saldo Akumulatif per Bulan
    let currentRunningSaldo = baperaSaldoAwalTahun;
    for (let m = 0; m < 12; m++) {
        let row = baperaMonthlySummary[m];
        row.netKasBulan = row.sharingRp + row.debitRp - row.kreditRp;
        currentRunningSaldo += row.netKasBulan;
        row.saldoAkumulatif = currentRunningSaldo;
    }

    baperaSaldoAkhirTahun = currentRunningSaldo;
}

// -----------------------------------------------------------------------------
// 4. Render Komponen UI PWA
// -----------------------------------------------------------------------------
function renderBaperaCards() {
    let nf = new Intl.NumberFormat('id-ID');

    let totalSharing = 0;
    let totalDebit = 0;
    let totalKredit = 0;
    let totalKg = 0;

    if (baperaCurrentYear === 'ALL') {
        baperaYearlySummary.forEach(y => {
            totalSharing += y.sharingRp;
            totalDebit += y.debitRp;
            totalKredit += y.kreditRp;
            totalKg += y.totalKgSharing;
        });
    } else {
        baperaMonthlySummary.forEach(m => {
            totalSharing += m.sharingRp;
            totalDebit += m.debitRp;
            totalKredit += m.kreditRp;
            totalKg += m.totalKgSharing;
        });
    }

    let elSaldoAwalTitle = document.getElementById('bapera-card-title-saldo-awal');
    let elSaldoAwal = document.getElementById('bapera-card-saldo-awal');
    let elSharing = document.getElementById('bapera-card-total-sharing');
    let elSharingKg = document.getElementById('bapera-card-total-kg');
    let elDebit = document.getElementById('bapera-card-total-debit');
    let elKredit = document.getElementById('bapera-card-total-kredit');
    let elSaldoAkhir = document.getElementById('bapera-card-saldo-akhir');

    if (elSaldoAwalTitle) {
        elSaldoAwalTitle.textContent = (baperaCurrentYear === 'ALL') ? "Saldo Awal (Des 2024)" : "Saldo Awal Tahun";
    }
    if (elSaldoAwal) elSaldoAwal.textContent = `Rp ${nf.format(baperaSaldoAwalTahun)}`;
    if (elSharing) elSharing.textContent = `Rp ${nf.format(totalSharing)}`;
    if (elSharingKg) elSharingKg.textContent = `${nf.format(totalKg)} Kg`;
    if (elDebit) elDebit.textContent = `Rp ${nf.format(totalDebit)}`;
    if (elKredit) elKredit.textContent = `Rp ${nf.format(totalKredit)}`;
    if (elSaldoAkhir) elSaldoAkhir.textContent = `Rp ${nf.format(baperaSaldoAkhirTahun)}`;
}

function renderBaperaTabelRekap() {
    let tbody = document.getElementById('bapera-tbody-rekap');
    let tfoot = document.getElementById('bapera-tfoot-rekap');
    let thPeriode = document.getElementById('bapera-th-periode');
    let btnTabRekapText = document.getElementById('bapera-btn-tab-rekap-text');
    if (!tbody) return;

    if (thPeriode) {
        thPeriode.textContent = (baperaCurrentYear === 'ALL') ? "Tahun Buku" : "Bulan";
    }
    if (btnTabRekapText) {
        btnTabRekapText.textContent = (baperaCurrentYear === 'ALL') ? "Rekap Tahunan" : "Rekap Bulanan";
    }

    let nf = new Intl.NumberFormat('id-ID');
    let html = "";

    let totMakoA = 0, totMakoS = 0, totMakoC = 0, totPongkol = 0, totSilase = 0;
    let totDebit = 0, totKredit = 0, totKas = 0;

    let rowsToRender = (baperaCurrentYear === 'ALL') ? baperaYearlySummary : baperaMonthlySummary;

    rowsToRender.forEach(row => {
        let f = row.feeds;
        let periodeLabel = (baperaCurrentYear === 'ALL') ? row.label : row.namaBulan;
        let netKas = (baperaCurrentYear === 'ALL') ? row.netKas : row.netKasBulan;
        let saldo = (baperaCurrentYear === 'ALL') ? row.saldoAkhir : row.saldoAkumulatif;

        totMakoA += f['Mako A-20'] || 0;
        totMakoS += f['Mako S-20'] || 0;
        totMakoC += f['Mako C-20'] || 0;
        totPongkol += f['Pongkol Singkong'] || 0;
        totSilase += f['Silase Jagung Manis'] || 0;
        totDebit += row.debitRp || 0;
        totKredit += row.kreditRp || 0;
        totKas += netKas || 0;

        let kasClass = netKas >= 0 ? "color:#15803d;" : "color:#dc2626;";

        html += `
            <tr style="border-bottom:1px solid #f1f5f9; font-size:12px;">
                <td style="padding:10px 8px; font-weight:700; color:#1e293b;">${periodeLabel}</td>
                <td style="padding:10px 8px; text-align:right; color:#334155;">${f['Mako A-20'] > 0 ? nf.format(f['Mako A-20']) : '-'}</td>
                <td style="padding:10px 8px; text-align:right; color:#334155;">${f['Mako S-20'] > 0 ? nf.format(f['Mako S-20']) : '-'}</td>
                <td style="padding:10px 8px; text-align:right; color:#334155;">${f['Mako C-20'] > 0 ? nf.format(f['Mako C-20']) : '-'}</td>
                <td style="padding:10px 8px; text-align:right; color:#334155;">${f['Pongkol Singkong'] > 0 ? nf.format(f['Pongkol Singkong']) : '-'}</td>
                <td style="padding:10px 8px; text-align:right; color:#334155;">${f['Silase Jagung Manis'] > 0 ? nf.format(f['Silase Jagung Manis']) : '-'}</td>
                <td style="padding:10px 8px; text-align:right; color:#0284c7; font-weight:600;">${row.debitRp > 0 ? nf.format(row.debitRp) : '-'}</td>
                <td style="padding:10px 8px; text-align:right; color:#dc2626; font-weight:600;">${row.kreditRp > 0 ? nf.format(row.kreditRp) : '-'}</td>
                <td style="padding:10px 8px; text-align:right; font-weight:700; ${kasClass}">
                    ${netKas !== 0 ? (netKas < 0 ? `(${nf.format(Math.abs(netKas))})` : nf.format(netKas)) : '-'}
                </td>
                <td style="padding:10px 8px; text-align:right; font-weight:800; color:#0f172a; background:#f8fafc;">
                    ${nf.format(saldo)}
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;

    if (tfoot) {
        let totKasClass = totKas >= 0 ? "color:#15803d;" : "color:#dc2626;";
        let labelGrand = (baperaCurrentYear === 'ALL') ? "GRAND TOTAL (SEMUA TAHUN)" : "GRAND TOTAL";
        tfoot.innerHTML = `
            <tr style="background:#fef08a; font-size:12px; font-weight:800; border-top:2px solid #ca8a04;">
                <td style="padding:12px 8px; color:#854d0e;">${labelGrand}</td>
                <td style="padding:12px 8px; text-align:right;">${nf.format(totMakoA)}</td>
                <td style="padding:12px 8px; text-align:right;">${nf.format(totMakoS)}</td>
                <td style="padding:12px 8px; text-align:right;">${nf.format(totMakoC)}</td>
                <td style="padding:12px 8px; text-align:right;">${nf.format(totPongkol)}</td>
                <td style="padding:12px 8px; text-align:right;">${nf.format(totSilase)}</td>
                <td style="padding:12px 8px; text-align:right; color:#0284c7;">${nf.format(totDebit)}</td>
                <td style="padding:12px 8px; text-align:right; color:#dc2626;">${nf.format(totKredit)}</td>
                <td style="padding:12px 8px; text-align:right; ${totKasClass}">${totKas < 0 ? `(${nf.format(Math.abs(totKas))})` : nf.format(totKas)}</td>
                <td style="padding:12px 8px; text-align:right; color:#0f172a; background:#fef9c3;">${nf.format(baperaSaldoAkhirTahun)}</td>
            </tr>
        `;
    }
}

function renderBaperaTabelMutasi() {
    let tbody = document.getElementById('bapera-tbody-mutasi');
    if (!tbody) return;

    let nf = new Intl.NumberFormat('id-ID');
    let cfList = (baperaCurrentYear === 'ALL')
        ? baperaCashflowRaw.filter(cf => String(cf.kategori || '').trim() !== 'Saldo Awal')
        : baperaCashflowRaw.filter(cf => {
            let tgl = cf.tanggal || '';
            return tgl >= `${baperaCurrentYear}-01-01` && tgl <= `${baperaCurrentYear}-12-31` && String(cf.kategori || '').trim() !== 'Saldo Awal';
        });

    if (cfList.length === 0) {
        let thnText = (baperaCurrentYear === 'ALL') ? "semua tahun" : `tahun ${baperaCurrentYear}`;
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center; padding:30px; color:#94a3b8; font-style:italic;">
                    Belum ada pencatatan operasional kas masuk/keluar BAPERA pada ${thnText}.
                </td>
            </tr>
        `;
        return;
    }

    let html = "";
    cfList.forEach((row, idx) => {
        let isMasuk = String(row.jenis || '').toLowerCase().includes('masuk');
        let badgeJenis = isMasuk 
            ? `<span style="background:#dcfce7; color:#15803d; padding:3px 8px; border-radius:4px; font-weight:700; font-size:10px;">MASUK</span>`
            : `<span style="background:#fee2e2; color:#b91c1c; padding:3px 8px; border-radius:4px; font-weight:700; font-size:10px;">KELUAR</span>`;
        
        let warnaNominal = isMasuk ? "color:#15803d;" : "color:#dc2626;";

        let buktiBtn = (row.bukti_url && row.bukti_url !== '-') 
            ? `<button onclick="bukaModalFotoBuktiBapera('${row.bukti_url}', '${encodeURIComponent(row.keterangan || '')}')" style="background:#eff6ff; border:1px solid #bfdbfe; color:#1d4ed8; border-radius:5px; padding:3px 7px; font-size:11px; cursor:pointer; display:inline-flex; align-items:center; gap:3px;">
                <span class="material-symbols-outlined" style="font-size:14px;">image</span> Lihat
               </button>`
            : `<span style="color:#cbd5e1; font-size:11px;">-</span>`;

        html += `
            <tr style="border-bottom:1px solid #f1f5f9; font-size:12px;">
                <td style="padding:10px 8px; text-align:center; color:#64748b;">${idx + 1}</td>
                <td style="padding:10px 8px; white-space:nowrap; font-weight:600; color:#1e293b;">${formatTanggalIndo(row.tanggal)}</td>
                <td style="padding:10px 8px; text-align:center;">${badgeJenis}</td>
                <td style="padding:10px 8px; color:#475569; font-weight:500;">${row.kategori || '-'}</td>
                <td style="padding:10px 8px; color:#1e293b;">${row.keterangan || '-'}</td>
                <td style="padding:10px 8px; text-align:right; font-weight:700; ${warnaNominal}">Rp ${nf.format(row.nominal || 0)}</td>
                <td style="padding:10px 8px; text-align:center;">${buktiBtn}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

function switchBaperaSubTab(tabName) {
    let btnRekap = document.getElementById('bapera-btn-tab-rekap');
    let btnMutasi = document.getElementById('bapera-btn-tab-mutasi');
    let viewRekap = document.getElementById('bapera-view-rekap');
    let viewMutasi = document.getElementById('bapera-view-mutasi');

    if (tabName === 'rekap') {
        if (btnRekap) { btnRekap.style.background = '#0284c7'; btnRekap.style.color = '#ffffff'; }
        if (btnMutasi) { btnMutasi.style.background = '#ffffff'; btnMutasi.style.color = '#475569'; }
        if (viewRekap) viewRekap.classList.remove('hidden');
        if (viewMutasi) viewMutasi.classList.add('hidden');
    } else {
        if (btnRekap) { btnRekap.style.background = '#ffffff'; btnRekap.style.color = '#475569'; }
        if (btnMutasi) { btnMutasi.style.background = '#0284c7'; btnMutasi.style.color = '#ffffff'; }
        if (viewRekap) viewRekap.classList.add('hidden');
        if (viewMutasi) viewMutasi.classList.remove('hidden');
    }
}

// -----------------------------------------------------------------------------
// 5. Input Kas Operasional BAPERA (Cash IN / OUT)
// -----------------------------------------------------------------------------
function bukaModalCatatKasBapera() {
    let modal = document.getElementById('modal-catat-kas-bapera');
    if (!modal) return;

    document.getElementById('bapera_in_tgl').valueAsDate = new Date();
    document.getElementById('bapera_in_jenis').value = "Keluar";
    document.getElementById('bapera_in_kategori').value = "Konsumsi Rapat";
    document.getElementById('bapera_in_nominal').value = "";
    document.getElementById('bapera_in_keterangan').value = "";
    document.getElementById('bapera_in_file').value = "";
    baperaFileBuktiBase64 = null;
    baperaFileBuktiMime = null;
    
    let prev = document.getElementById('bapera-preview-img-container');
    if (prev) prev.style.display = 'none';

    modal.classList.remove('hidden');
}

function tutupModalCatatKasBapera() {
    let modal = document.getElementById('modal-catat-kas-bapera');
    if (modal) modal.classList.add('hidden');
}

function handleUploadBuktiBapera(input) {
    if (input.files && input.files[0]) {
        let file = input.files[0];
        baperaFileBuktiMime = file.type;
        let reader = new FileReader();
        reader.onload = function(e) {
            baperaFileBuktiBase64 = e.target.result.split(',')[1];
            let prevContainer = document.getElementById('bapera-preview-img-container');
            let prevImg = document.getElementById('bapera-preview-img');
            if (prevContainer && prevImg) {
                prevImg.src = e.target.result;
                prevContainer.style.display = 'block';
            }
        };
        reader.readAsDataURL(file);
    }
}

async function simpanKasBapera() {
    let tgl = document.getElementById('bapera_in_tgl').value;
    let jenis = document.getElementById('bapera_in_jenis').value;
    let kat = document.getElementById('bapera_in_kategori').value.trim();
    let nominalRaw = document.getElementById('bapera_in_nominal').value.replace(/[^0-9]/g, '');
    let nominal = parseInt(nominalRaw) || 0;
    let ket = document.getElementById('bapera_in_keterangan').value.trim();

    if (!tgl) return alert("Pilih tanggal transaksi terlebih dahulu!");
    if (!kat) return alert("Isi atau pilih kategori transaksi!");
    if (nominal <= 0) return alert("Nominal transaksi harus lebih dari 0!");
    if (!ket) return alert("Tuliskan keterangan transaksi!");

    let btn = document.getElementById('btn-simpan-kas-bapera');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="material-symbols-outlined icon-spin" style="font-size:16px;">sync</span> Menyimpan...`;
    }

    try {
        let buktiUrl = "-";

        // Upload bukti jika ada
        if (baperaFileBuktiBase64 && typeof uploadGambarKeSupabase === 'function') {
            let namaFile = `BAPERA_${tgl}_${Date.now()}.jpg`;
            buktiUrl = await uploadGambarKeSupabase(baperaFileBuktiBase64, baperaFileBuktiMime, 'cashflow', namaFile);
        }

        let payload = {
            tanggal: tgl,
            jenis: jenis,
            metode: 'Cash',
            kategori: kat,
            relasi: 'BAPERA',
            nominal: nominal,
            diskon: 0,
            keterangan: ket,
            bukti_url: buktiUrl,
            petugas: (typeof activeUser !== 'undefined' && activeUser) ? activeUser : 'Admin'
        };

        let res = await fetch(`${SUPA_URL}/rest/v1/cashflow`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || "Gagal menyimpan ke database");
        }

        alert("Transaksi Kas BAPERA berhasil disimpan!");
        tutupModalCatatKasBapera();
        fetchDataBapera(baperaCurrentYear, true);

    } catch (e) {
        console.error("Error simpan kas BAPERA:", e);
        alert("Gagal menyimpan transaksi: " + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `Simpan Transaksi Kas`;
        }
    }
}

function bukaModalFotoBuktiBapera(url, keteranganEscaped) {
    let modal = document.getElementById('modal-foto-bukti-bapera');
    let img = document.getElementById('bapera-bukti-fullscreen');
    let caption = document.getElementById('bapera-bukti-caption');
    if (!modal || !img) return;

    img.src = url;
    if (caption) caption.textContent = decodeURIComponent(keteranganEscaped || '');
    modal.classList.remove('hidden');
}

function tutupModalFotoBuktiBapera() {
    let modal = document.getElementById('modal-foto-bukti-bapera');
    if (modal) modal.classList.add('hidden');
}

// -----------------------------------------------------------------------------
// 6. Cetak Laporan Rekapitulasi Tahunan & Semua Tahun (A4 Portrait - 1 Halaman Pas)
// -----------------------------------------------------------------------------
function cetakLaporanBaperaA4() {
    let nf = new Intl.NumberFormat('id-ID');
    let isAll = (baperaCurrentYear === 'ALL');
    let tahun = baperaCurrentYear;

    let baseUrl = window.location.href.split('?')[0];
    let auditUrl = `${baseUrl}?audit_bapera=${tahun}`;

    let totalSharing = 0;
    let totalDebit = 0;
    let totalKredit = 0;
    let totalKg = 0;

    if (isAll) {
        baperaYearlySummary.forEach(y => {
            totalSharing += y.sharingRp;
            totalDebit += y.debitRp;
            totalKredit += y.kreditRp;
            totalKg += y.totalKgSharing;
        });
    } else {
        baperaMonthlySummary.forEach(m => {
            totalSharing += m.sharingRp;
            totalDebit += m.debitRp;
            totalKredit += m.kreditRp;
            totalKg += m.totalKgSharing;
        });
    }

    // Baris Tabel Pakan (Monokrom #0f172a)
    let pakanKeys = ['Mako A-20', 'Mako S-20', 'Mako C-20', 'Pongkol Singkong', 'Silase Jagung Manis'];
    let pakanRowsHtml = pakanKeys.map(key => {
        let item = baperaFeedSummary[key] || { kg: 0, tarif: 20, totalRp: 0 };
        return `
            <tr style="font-size:10.5px;">
                <td style="border:1px solid #cbd5e1; padding:5px 8px; font-weight:600; color:#0f172a;">${key}</td>
                <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">${nf.format(item.kg)} Kg</td>
                <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:center; color:#0f172a;">Rp ${nf.format(item.tarif)} / kg</td>
                <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; font-weight:700; color:#0f172a;">Rp ${nf.format(item.totalRp)}</td>
            </tr>
        `;
    }).join('');

    // Baris Tabel Ringkasan Pertumbuhan per Tahun (Khusus SEMUA TAHUN)
    let yearlyRowsHtml = "";
    if (isAll) {
        yearlyRowsHtml = baperaYearlySummary.map(y => {
            let netKas = y.netKas;
            let netKasStr = (netKas < 0) ? `(${nf.format(Math.abs(netKas))})` : nf.format(netKas);
            return `
                <tr style="font-size:10.5px;">
                    <td style="border:1px solid #cbd5e1; padding:5px 8px; font-weight:700; color:#0f172a;">${y.label}</td>
                    <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">${nf.format(y.totalKgSharing)} Kg</td>
                    <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; font-weight:600; color:#0f172a;">Rp ${nf.format(y.sharingRp)}</td>
                    <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">${y.debitRp > 0 ? `Rp ${nf.format(y.debitRp)}` : '-'}</td>
                    <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">${y.kreditRp > 0 ? `Rp ${nf.format(y.kreditRp)}` : '-'}</td>
                    <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; font-weight:700; color:#0f172a;">Rp ${netKasStr}</td>
                    <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; font-weight:800; color:#0f172a; background:#f8fafc;">Rp ${nf.format(y.saldoAkhir)}</td>
                </tr>
            `;
        }).join('');
    }

    // Baris Tabel Pengeluaran & Pemasukan Lain-Lain (Diagregasi per Kategori)
    let katKeluarKeys = Object.keys(baperaCategorySummary.keluar);
    let katMasukKeys = Object.keys(baperaCategorySummary.masuk);
    let mutasiRowsHtml = "";

    if (katMasukKeys.length === 0 && katKeluarKeys.length === 0) {
        mutasiRowsHtml = `
            <tr style="font-size:10.5px;">
                <td colspan="3" style="border:1px solid #cbd5e1; padding:6px; text-align:center; color:#64748b; font-style:italic;">
                    Tidak ada transaksi operasional lain pada periode ini.
                </td>
            </tr>
        `;
    } else {
        katMasukKeys.forEach(k => {
            let nom = baperaCategorySummary.masuk[k];
            mutasiRowsHtml += `
                <tr style="font-size:10.5px;">
                    <td style="border:1px solid #cbd5e1; padding:4px 8px; font-weight:600; color:#0f172a;">${k}</td>
                    <td style="border:1px solid #cbd5e1; padding:4px 8px; text-align:center; color:#0f172a; font-weight:600;">Masuk (Debit)</td>
                    <td style="border:1px solid #cbd5e1; padding:4px 8px; text-align:right; font-weight:700; color:#0f172a;">Rp ${nf.format(nom)}</td>
                </tr>
            `;
        });
        katKeluarKeys.forEach(k => {
            let nom = baperaCategorySummary.keluar[k];
            mutasiRowsHtml += `
                <tr style="font-size:10.5px;">
                    <td style="border:1px solid #cbd5e1; padding:4px 8px; font-weight:600; color:#0f172a;">${k}</td>
                    <td style="border:1px solid #cbd5e1; padding:4px 8px; text-align:center; color:#0f172a; font-weight:600;">Keluar (Kredit)</td>
                    <td style="border:1px solid #cbd5e1; padding:4px 8px; text-align:right; font-weight:700; color:#0f172a;">Rp ${nf.format(nom)}</td>
                </tr>
            `;
        });
    }

    let printWin = window.open('', '_blank', 'width=850,height=950');
    if (!printWin) {
        alert("Pop-up browser terblokir. Izinkan pop-up untuk mencetak dokumen.");
        return;
    }

    let tglCetak = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    let rentangDataText = "";
    let periodeDocText = "";
    let docTitle = "";
    let pdfFilename = "";

    if (isAll) {
        docTitle = `Laporan Rekapitulasi Kas BAPERA - Semua Tahun (Rekap Lengkap)`;
        periodeDocText = `PERIODE: REKAPITULASI LENGKAP (SEMUA TAHUN)`;
        rentangDataText = `31 Desember 2024 s/d ${tglCetak}`;
        pdfFilename = `Laporan_Kas_BAPERA_Semua_Tahun.pdf`;
    } else {
        docTitle = `Laporan Rekapitulasi Kas BAPERA - Tahun ${tahun}`;
        periodeDocText = `PERIODE TAHUN BUKU: ${tahun}`;
        let now = new Date();
        let tahunNow = now.getFullYear();
        if (tahun < tahunNow) {
            rentangDataText = `1 Januari ${tahun} s/d 31 Desember ${tahun}`;
        } else {
            rentangDataText = `1 Januari ${tahun} s/d ${tglCetak}`;
        }
        pdfFilename = `Laporan_Kas_BAPERA_${tahun}.pdf`;
    }

    // Bagian Rangkuman Pertumbuhan Tahunan jika mencetak SEMUA TAHUN
    let sectionYearlyGrowthHtml = "";
    if (isAll) {
        sectionYearlyGrowthHtml = `
            <div class="section-title">III. Rangkuman Pertumbuhan Kas per Tahun Buku</div>
            <table style="margin-bottom:8px;">
                <thead>
                    <tr style="background:#f1f5f9; font-size:9.5px; text-transform:uppercase;">
                        <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:left;">Tahun Buku</th>
                        <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:95px;">Volume (Kg)</th>
                        <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:110px;">Sharing Pakan</th>
                        <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:90px;">Masuk Lain</th>
                        <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:90px;">Pengeluaran</th>
                        <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:95px;">Kas Bersih</th>
                        <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:100px;">Saldo Akhir</th>
                    </tr>
                </thead>
                <tbody>
                    ${yearlyRowsHtml}
                </tbody>
                <tfoot>
                    <tr style="background:#f8fafc; font-size:10.5px; font-weight:800;">
                        <td style="border:1px solid #cbd5e1; padding:5px 8px; color:#0f172a;">GRAND TOTAL</td>
                        <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">${nf.format(totalKg)} Kg</td>
                        <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">Rp ${nf.format(totalSharing)}</td>
                        <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">Rp ${nf.format(totalDebit)}</td>
                        <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">Rp ${nf.format(totalKredit)}</td>
                        <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">Rp ${nf.format(totalSharing + totalDebit - totalKredit)}</td>
                        <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a; background:#f1f5f9;">Rp ${nf.format(baperaSaldoAkhirTahun)}</td>
                    </tr>
                </tfoot>
            </table>
        `;
    }

    let sectionNumberOperasional = isAll ? "IV" : "III";

    printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>${docTitle}</title>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    background: #ffffff;
                    color: #0f172a;
                    margin: 0;
                    padding: 16px 20px;
                }
                #printable-doc {
                    width: 714px;
                    margin: 0 auto;
                    box-sizing: border-box;
                }
                .kop-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 2px solid #0f172a;
                    padding-bottom: 8px;
                    margin-bottom: 10px;
                }
                .kop-title {
                    font-size: 15px;
                    font-weight: 800;
                    color: #0f172a;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                }
                .section-title {
                    font-size: 10.5px;
                    font-weight: 800;
                    color: #0f172a;
                    text-transform: uppercase;
                    letter-spacing: 0.4px;
                    margin: 8px 0 4px 0;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                }
                .qr-box {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    background: #f8fafc;
                    border: 1px solid #0f172a;
                    border-radius: 6px;
                    padding: 8px 12px;
                    margin: 8px 0 10px 0;
                    page-break-inside: avoid;
                }
                .signatures {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    text-align: center;
                    margin-top: 14px;
                    font-size: 11px;
                    page-break-inside: avoid;
                }
                .sig-line {
                    margin-top: 40px;
                    font-weight: 800;
                    text-decoration: underline;
                }
                @media print {
                    @page { size: A4 portrait; margin: 8mm 10mm; }
                    body { padding: 0; }
                    .no-print { display: none !important; }
                }
            </style>
        </head>
        <body>
            <div class="no-print" style="margin-bottom:12px; display:flex; justify-content:flex-end; gap:8px;">
                <button onclick="downloadPdfDoc()" style="padding:7px 12px; background:#0284c7; color:white; border:none; border-radius:6px; font-weight:bold; font-size:11px; cursor:pointer;">
                    📥 Download PDF (1 Halaman)
                </button>
                <button onclick="window.print()" style="padding:7px 12px; background:#0f172a; color:white; border:none; border-radius:6px; font-weight:bold; font-size:11px; cursor:pointer;">
                    🖨️ Cetak Dokumen
                </button>
                <button onclick="window.close()" style="padding:7px 12px; background:#64748b; color:white; border:none; border-radius:6px; font-size:11px; cursor:pointer;">
                    Tutup
                </button>
            </div>

            <div id="printable-doc">
                <!-- KOP SURAT DENGAN LOGO PT CBL -->
                <div class="kop-header">
                    <div style="display:flex; align-items:center; gap:12px;">
                        <img src="https://raw.githubusercontent.com/wildansyif/pakan-cbl/2e732398572a6ac7d3512559c4344d40ab0902f9/Logo%20CBL.png" 
                             alt="Logo PT CBL" 
                             onerror="this.onerror=null; this.src='Logo%20CBL.png';"
                             style="height:44px; width:auto; object-fit:contain;" />
                        <div>
                            <div class="kop-title">LAPORAN REKAPITULASI KAS BAPERA</div>
                            <div style="font-size:11px; font-weight:800; color:#0f172a; margin-top:2px;">${periodeDocText}</div>
                            <div style="font-size:9.5px; color:#475569; margin-top:1px; font-weight:600;">
                                Rentang Data: <span style="color:#0f172a;">${rentangDataText}</span>
                            </div>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="background:#0f172a; color:#ffffff; font-size:9px; font-weight:800; padding:3px 7px; border-radius:4px; display:inline-block; margin-bottom:2px;">
                            DOKUMEN RESMI
                        </div>
                        <div style="font-size:9.5px; color:#64748b;">Tanggal Cetak: ${tglCetak}</div>
                    </div>
                </div>

                <!-- 1. RINGKASAN EKSEKUTIF (TABEL HORIZONTAL MONOKROM) -->
                <div class="section-title">I. Ringkasan Eksekutif Kas BAPERA</div>
                <table style="margin-bottom:8px;">
                    <thead>
                        <tr style="background:#f1f5f9; font-size:9.5px; text-transform:uppercase;">
                            <th style="border:1px solid #cbd5e1; padding:5px 6px; text-align:center; width:20%;">${isAll ? 'Saldo Awal (Des 2024)' : 'Saldo Awal'}</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 6px; text-align:center; width:20%;">Total Sharing Pakan</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 6px; text-align:center; width:20%;">Pemasukan Lain (Debit)</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 6px; text-align:center; width:20%;">Pengeluaran (Kredit)</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 6px; text-align:center; width:20%; background:#e2e8f0;">Saldo Akhir Kas</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr style="font-size:11px; font-weight:800;">
                            <td style="border:1px solid #cbd5e1; padding:6px 6px; text-align:center; color:#0f172a;">Rp ${nf.format(baperaSaldoAwalTahun)}</td>
                            <td style="border:1px solid #cbd5e1; padding:6px 6px; text-align:center; color:#0f172a;">Rp ${nf.format(totalSharing)}</td>
                            <td style="border:1px solid #cbd5e1; padding:6px 6px; text-align:center; color:#0f172a;">Rp ${nf.format(totalDebit)}</td>
                            <td style="border:1px solid #cbd5e1; padding:6px 6px; text-align:center; color:#0f172a;">Rp ${nf.format(totalKredit)}</td>
                            <td style="border:1px solid #cbd5e1; padding:6px 6px; text-align:center; color:#0f172a; background:#f8fafc;">Rp ${nf.format(baperaSaldoAkhirTahun)}</td>
                        </tr>
                    </tbody>
                </table>

                <!-- 2. TABEL KONTRIBUSI SHARING PAKAN -->
                <div class="section-title">II. Rincian Kontribusi Sharing Penjualan per Jenis Pakan ${isAll ? '(Kumulatif)' : ''}</div>
                <table style="margin-bottom:8px;">
                    <thead>
                        <tr style="background:#f1f5f9; font-size:9.5px; text-transform:uppercase;">
                            <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:left;">Jenis Pakan</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:120px;">Total Terjual</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:center; width:110px;">Tarif Sharing</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:140px;">Total Hak BAPERA</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${pakanRowsHtml}
                    </tbody>
                    <tfoot>
                        <tr style="background:#f8fafc; font-size:10.5px; font-weight:800;">
                            <td style="border:1px solid #cbd5e1; padding:5px 8px; color:#0f172a;">TOTAL KONTRIBUSI PAKAN</td>
                            <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">${nf.format(totalKg)} Kg</td>
                            <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:center; color:#0f172a;">-</td>
                            <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">Rp ${nf.format(totalSharing)}</td>
                        </tr>
                    </tfoot>
                </table>

                <!-- 3. TABEL RANGKUMAN PERTUMBUHAN PER TAHUN BUKU (HANYA UNTUK SEMUA TAHUN) -->
                ${sectionYearlyGrowthHtml}

                <!-- 4. TABEL MUTASI OPERASIONAL LAIN-LAIN -->
                <div class="section-title">${sectionNumberOperasional}. Rincian Pengeluaran & Pemasukan Lain-Lain (Operasional) ${isAll ? 'Kumulatif' : ''}</div>
                <table style="margin-bottom:8px;">
                    <thead>
                        <tr style="background:#f1f5f9; font-size:9.5px; text-transform:uppercase;">
                            <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:left;">Kategori Transaksi</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:center; width:140px;">Jenis Arus Kas</th>
                            <th style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; width:140px;">Total Nominal</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${mutasiRowsHtml}
                    </tbody>
                    <tfoot>
                        <tr style="background:#f8fafc; font-size:10.5px; font-weight:800;">
                            <td colspan="2" style="border:1px solid #cbd5e1; padding:5px 8px; color:#0f172a;">TOTAL PENGELUARAN LAIN (KREDIT)</td>
                            <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">Rp ${nf.format(totalKredit)}</td>
                        </tr>
                        <tr style="background:#f8fafc; font-size:10.5px; font-weight:800;">
                            <td colspan="2" style="border:1px solid #cbd5e1; padding:5px 8px; color:#0f172a;">TOTAL PEMASUKAN LAIN (DEBIT)</td>
                            <td style="border:1px solid #cbd5e1; padding:5px 8px; text-align:right; color:#0f172a;">Rp ${nf.format(totalDebit)}</td>
                        </tr>
                    </tfoot>
                </table>

                <!-- 5. KOTAK VERIFIKASI QR CODE -->
                <div class="qr-box">
                    <div style="flex-shrink:0; background:#ffffff; padding:3px; border:1px solid #cbd5e1; border-radius:5px;">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=90x90&margin=0&data=${encodeURIComponent(auditUrl)}" 
                             alt="QR Code Audit Kas BAPERA" 
                             width="72" height="72" 
                             style="display:block; width:72px; height:72px;" />
                    </div>
                    <div style="flex:1;">
                        <div style="display:inline-block; background:#0f172a; color:#ffffff; font-size:8.5px; font-weight:800; padding:2px 5px; border-radius:3px; margin-bottom:2px;">
                            SCAN UNTUK AUDIT DIGITAL LENGKAP
                        </div>
                        <div style="font-size:11px; font-weight:800; color:#0f172a; margin-bottom:2px;">Verifikasi Rincian Kas Operasional Per Tanggal ${isAll ? '(Semua Periode)' : ''}</div>
                        <div style="font-size:9.5px; color:#64748b; line-height:1.3; margin-bottom:3px;">
                            Arahkan kamera HP ke barcode untuk melihat rincian tanggal transaksi pengeluaran dan pemasukan lain-lain beserta foto kuitansi/nota belanja dari brankas cloud.
                        </div>
                        <div style="font-size:8.5px; color:#0f172a; font-weight:700; word-break:break-all;">
                            🔗 ${auditUrl}
                        </div>
                    </div>
                </div>

                <!-- 6. TANDA TANGAN -->
                <div class="signatures">
                    <div>
                        <div>Pengelola Distribusi Pakan CBL,</div>
                        <div class="sig-line">( Admin Pusat / PT CBL )</div>
                    </div>
                    <div>
                        <div>Mengetahui / Menyetujui,</div>
                        <div class="sig-line">( Pengurus BAPERA )</div>
                    </div>
                </div>
            </div>

            <script>
                function downloadPdfDoc() {
                    const el = document.getElementById('printable-doc');
                    const opt = {
                        margin: [8, 8, 8, 8],
                        filename: '${pdfFilename}',
                        image: { type: 'jpeg', quality: 0.98 },
                        html2canvas: { scale: 2, useCORS: true },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                    };
                    html2pdf().set(opt).from(el).save();
                }
            </script>
        </body>
        </html>
    `);

    printWin.document.close();
}

// -----------------------------------------------------------------------------
// 7. Halaman Tamu / Publik Verifikasi Audit QR Code
// -----------------------------------------------------------------------------
async function bukaLayarAuditBaperaPublik(tahun) {
    let appScreen = document.getElementById('app-screen');
    let loginScreen = document.getElementById('login-screen');
    if (loginScreen) loginScreen.style.setProperty('display', 'none', 'important');
    if (appScreen) appScreen.classList.remove('hidden');

    let isAll = (String(tahun).toUpperCase() === 'ALL');

    let existing = document.getElementById('screen-audit-bapera-digital');
    if (existing) existing.remove();

    let screenEl = document.createElement('div');
    screenEl.id = 'screen-audit-bapera-digital';
    screenEl.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: #f8fafc; z-index: 999999; overflow-y: auto; padding: 20px 14px;
        box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    let subJudulAudit = isAll
        ? `Rincian Seluruh Mutasi Operasional Sejak Awal Transaksi (Semua Periode)`
        : `Rincian Mutasi Operasional Tahun Buku <b>${tahun}</b>`;

    screenEl.innerHTML = `
        <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,0.06); padding: 20px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px solid #e2e8f0; padding-bottom:12px; margin-bottom:14px;">
                <div>
                    <span style="background:#0284c7; color:#fff; font-size:10px; font-weight:800; padding:3px 8px; border-radius:4px;">VERIFIKASI RESMI CLOUD</span>
                    <h2 style="font-size:16px; font-weight:800; color:#0f172a; margin:6px 0 2px 0;">Audit Digital Kas BAPERA</h2>
                    <div style="font-size:11px; color:#64748b;">${subJudulAudit}</div>
                </div>
                <button onclick="tutupLayarAuditBaperaPublik()" style="background:#f1f5f9; border:none; color:#64748b; padding:6px 10px; border-radius:8px; font-size:11px; font-weight:700; cursor:pointer;">
                    ✕ Tutup
                </button>
            </div>

            <div id="audit-bapera-loader" style="text-align:center; padding:40px 10px; color:#0284c7;">
                <span class="material-symbols-outlined icon-spin" style="font-size:32px;">sync</span>
                <div style="font-size:12px; font-weight:700; margin-top:8px;">Memverifikasi Data dari Brankas Cloud CBL...</div>
            </div>

            <div id="audit-bapera-content" class="hidden">
                <!-- Diisi via JS -->
            </div>
        </div>
    `;

    document.body.appendChild(screenEl);

    try {
        let fnFetch = (typeof fetchSupabaseAll === 'function') ? fetchSupabaseAll : null;
        let url = isAll
            ? `${SUPA_URL}/rest/v1/cashflow?relasi=ilike.*BAPERA*&order=tanggal.asc,id.asc`
            : `${SUPA_URL}/rest/v1/cashflow?relasi=ilike.*BAPERA*&tanggal=gte.${tahun}-01-01&tanggal=lte.${tahun}-12-31&order=tanggal.asc,id.asc`;
        
        let rawData = fnFetch ? await fnFetch(url) : await fetch(url, { headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` } }).then(r => r.json());
        let data = (rawData || []).filter(row => String(row.kategori || '').trim() !== 'Saldo Awal');

        let loader = document.getElementById('audit-bapera-loader');
        let content = document.getElementById('audit-bapera-content');
        if (loader) loader.classList.add('hidden');
        if (content) content.classList.remove('hidden');

        let nf = new Intl.NumberFormat('id-ID');
        let listHtml = "";
        let totMasuk = 0;
        let totKeluar = 0;

        data.forEach(row => {
            let nom = parseFloat(row.nominal) || 0;
            let isMasuk = String(row.jenis || '').toLowerCase().includes('masuk');
            if (isMasuk) totMasuk += nom; else totKeluar += nom;

            let badgeJenis = isMasuk 
                ? `<span style="background:#dcfce7; color:#15803d; padding:2px 6px; border-radius:4px; font-size:9.5px; font-weight:800;">MASUK</span>`
                : `<span style="background:#fee2e2; color:#b91c1c; padding:2px 6px; border-radius:4px; font-size:9.5px; font-weight:800;">KELUAR</span>`;

            let btnBukti = (row.bukti_url && row.bukti_url !== '-') 
                ? `<a href="${row.bukti_url}" target="_blank" style="background:#eff6ff; color:#1d4ed8; text-decoration:none; padding:3px 7px; border-radius:5px; font-size:10px; font-weight:700; display:inline-flex; align-items:center; gap:2px;">
                    <span class="material-symbols-outlined" style="font-size:12px;">visibility</span> Foto Nota
                   </a>`
                : '';

            listHtml += `
                <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:8px; box-shadow:0 1px 3px rgba(0,0,0,0.02);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <span style="font-size:11px; font-weight:700; color:#64748b;">${formatTanggalIndo(row.tanggal)}</span>
                        ${badgeJenis}
                    </div>
                    <div style="font-size:13px; font-weight:800; color:#0f172a; margin-bottom:3px;">${row.keterangan || '-'}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
                        <span style="font-size:10.5px; color:#64748b; background:#f1f5f9; padding:2px 6px; border-radius:4px;">${row.kategori || 'Operasional'}</span>
                        <div style="text-align:right;">
                            <span style="font-size:13px; font-weight:800; ${isMasuk ? 'color:#15803d;' : 'color:#dc2626;'}">
                                ${isMasuk ? '+' : '-'} Rp ${nf.format(nom)}
                            </span>
                        </div>
                    </div>
                    ${btnBukti ? `<div style="margin-top:6px; text-align:right;">${btnBukti}</div>` : ''}
                </div>
            `;
        });

        content.innerHTML = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px;">
                <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#15803d; font-weight:700;">TOTAL PEMASUKAN LAIN:</div>
                    <div style="font-size:14px; font-weight:800; color:#166534; margin-top:2px;">Rp ${nf.format(totMasuk)}</div>
                </div>
                <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:10px;">
                    <div style="font-size:10px; color:#b91c1c; font-weight:700;">TOTAL PENGELUARAN:</div>
                    <div style="font-size:14px; font-weight:800; color:#991b1b; margin-top:2px;">Rp ${nf.format(totKeluar)}</div>
                </div>
            </div>

            <div style="font-size:11.5px; font-weight:800; color:#0f172a; margin-bottom:8px;">
                Riwayat Transaksi Kronologis (${data.length} Transaksi):
            </div>
            ${listHtml || '<div style="text-align:center; padding:20px; color:#94a3b8;">Tidak ada data operasional lain.</div>'}
        `;

    } catch (e) {
        alert("Gagal memuat audit: " + e.message);
    }
}

function tutupLayarAuditBaperaPublik() {
    let el = document.getElementById('screen-audit-bapera-digital');
    if (el) el.remove();
    let params = new URLSearchParams(window.location.search);
    if (params.get('audit_bapera')) {
        window.location.href = window.location.pathname;
    }
}

// -----------------------------------------------------------------------------
// 8. One-Click Seeder Data Historis Spreadsheet (Jika Database Masih Kosong)
// -----------------------------------------------------------------------------
async function importDataHistorisBapera() {
    let konfirm = confirm("Apakah Anda yakin ingin mengimpor 36 baris data historis (Des 2024 s/d Nov 2026) dari spreadsheet ke Supabase?\n\nPastikan belum ada data duplikat.");
    if (!konfirm) return;

    let rowsToInsert = [
        // 1. Saldo Awal Cut-off Desember 2024
        { tanggal: '2024-12-31', jenis: 'Masuk', metode: 'Cash', kategori: 'Saldo Awal', relasi: 'BAPERA', nominal: 386000, diskon: 0, keterangan: 'Saldo Awal Kas BAPERA (Cut-off Des 2024)', bukti_url: '-', petugas: 'Admin' },
        // 2. Tahun 2025
        { tanggal: '2025-06-01', jenis: 'Masuk', metode: 'Transfer', kategori: 'Bagi Hasil', relasi: 'BAPERA', nominal: 350000, diskon: 0, keterangan: 'Share Penjualan Mesin Perah d/Adieb', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2025-07-01', jenis: 'Masuk', metode: 'Transfer', kategori: 'Bagi Hasil', relasi: 'BAPERA', nominal: 500000, diskon: 0, keterangan: 'Share Penjualan Mesin Perah d/Adieb', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2025-07-01', jenis: 'Keluar', metode: 'Transfer', kategori: 'Tarik Deposit', relasi: 'BAPERA', nominal: 4600000, diskon: 0, keterangan: 'Cashout (Tarik Deposit)', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2025-09-24', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi', relasi: 'BAPERA', nominal: 93000, diskon: 0, keterangan: 'Biaya konsumsi acara BUMDES', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2025-10-25', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 354000, diskon: 0, keterangan: 'Konsumsi acara BAPERA ft. BAR', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2025-11-08', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 300000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2025-11-22', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 360000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2025-12-13', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 331000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        // 3. Tahun 2026
        { tanggal: '2026-01-03', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 354000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-01-15', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 521000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-02-07', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 235000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-02-10', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 406000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-04-07', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 367000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-04-11', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 222000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-04-16', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 315000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-05-05', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 192000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-05-12', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 233000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-05-25', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 162000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-06-06', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 220000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-06-10', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 293000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-06-22', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 250000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-07-01', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 393000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-07-06', jenis: 'Keluar', metode: 'Transfer', kategori: 'Kasbon Mitra', relasi: 'BAPERA', nominal: 15500000, diskon: 0, keterangan: 'Kasbon Mitra BJB VIA Asep Dani (Susi 5.700.000 + Euis 9.800.000)', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-07-22', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 281000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-08-01', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 218000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-08-06', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 102000, diskon: 0, keterangan: 'Konsumsi Bapera x USDC', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-08-15', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 126000, diskon: 0, keterangan: 'Konsumsi Team Batang', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-08-24', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 232000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-09-05', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 198000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-09-21', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 295000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-09-28', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 180000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-10-01', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 250000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-10-13', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 218000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-11-04', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 296000, diskon: 0, keterangan: 'Konsumsi Rapat BAPERA', bukti_url: '-', petugas: 'Admin' },
        { tanggal: '2026-11-05', jenis: 'Keluar', metode: 'Cash', kategori: 'Konsumsi Rapat', relasi: 'BAPERA', nominal: 288000, diskon: 0, keterangan: 'Liwet u/ Konsumsi Bapera x BAR', bukti_url: '-', petugas: 'Admin' }
    ];

    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/cashflow`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(rowsToInsert)
        });

        if (!res.ok) {
            let err = await res.json();
            throw new Error(err.message || "Gagal import data");
        }

        alert("Sukses! 36 transaksi historis Kas BAPERA berhasil masuk ke database cloud.");
        fetchDataBapera(baperaCurrentYear);

    } catch (e) {
        console.error("Gagal import historis:", e);
        alert("Gagal impor data historis: " + e.message);
    }
}

// -----------------------------------------------------------------------------
// 9. Helper Format Tanggal Indonesia
// -----------------------------------------------------------------------------
function formatTanggalIndo(tglStr) {
    if (!tglStr) return "-";
    let p = tglStr.split('-');
    if (p.length === 3) {
        return `${p[2]}/${p[1]}/${p[0]}`;
    }
    return tglStr;
}

// -----------------------------------------------------------------------------
// 10. Listener Inisialisasi URL Parameter (QR Code Audit Bapera)
// -----------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    let params = new URLSearchParams(window.location.search);
    let auditTahun = params.get('audit_bapera');
    if (auditTahun) {
        let tVal = (auditTahun.toUpperCase() === 'ALL') ? 'ALL' : (parseInt(auditTahun) || new Date().getFullYear());
        bukaLayarAuditBaperaPublik(tVal);
    }
});

// Daftarkan ke Global Window agar dapat dipanggil dari HTML
window.initModulBapera = initModulBapera;
window.gantiTahunBapera = gantiTahunBapera;
window.fetchDataBapera = fetchDataBapera;
window.switchBaperaSubTab = switchBaperaSubTab;
window.bukaModalCatatKasBapera = bukaModalCatatKasBapera;
window.tutupModalCatatKasBapera = tutupModalCatatKasBapera;
window.handleUploadBuktiBapera = handleUploadBuktiBapera;
window.simpanKasBapera = simpanKasBapera;
window.bukaModalFotoBuktiBapera = bukaModalFotoBuktiBapera;
window.tutupModalFotoBuktiBapera = tutupModalFotoBuktiBapera;
window.cetakLaporanBaperaA4 = cetakLaporanBaperaA4;
window.bukaLayarAuditBaperaPublik = bukaLayarAuditBaperaPublik;
window.tutupLayarAuditBaperaPublik = tutupLayarAuditBaperaPublik;
window.importDataHistorisBapera = importDataHistorisBapera;
