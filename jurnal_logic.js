// ==========================================
// LOGIKA JURNAL UMUM (DOUBLE-ENTRY)
// Mengambil data dari view_jurnal_umum
// ==========================================

let jurnalDataGlobal = [];

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
        let fnFetch = (typeof fetchSupabaseAll === 'function') ? fetchSupabaseAll : (typeof window !== 'undefined' && typeof window.fetchSupabaseAll === 'function' ? window.fetchSupabaseAll : null);
        let urlTarget = `${SUPA_URL}/rest/v1/view_jurnal_umum?tanggal=gte.${start}&tanggal=lte.${end}&order=tanggal.asc,id_jurnal.asc`;
        
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
            else console.error("Gagal load jurnal", await res.text());
        }
        
        jurnalDataGlobal = data;
        renderJurnal(data);
    } catch (e) {
        console.error("Network error jurnal", e);
    } finally {
        if (!silent) document.getElementById('jurnal-loader').classList.add('hidden');
    }
}

function renderJurnal(data) {
    let tbody = document.getElementById('tbody-jurnal');
    let tDebit = 0;
    let tKredit = 0;
    
    let html = "";
    
    // Ambil nilai dari filter tambahan
    let fKode = document.getElementById('jurnal-kode').value;
    let fPerkiraan = document.getElementById('jurnal-perkiraan').value.toLowerCase();
    let fRelasi = document.getElementById('jurnal-relasi').value.toLowerCase();
    
    let filtered = data;
    
    if (fKode || fPerkiraan || fRelasi) {
        filtered = data.filter(d => {
            let matchKode = !fKode || (d.kode_akun && d.kode_akun.startsWith(fKode));
            let matchPerkiraan = !fPerkiraan || (d.nama_akun && d.nama_akun.toLowerCase().includes(fPerkiraan));
            // Autocomplete di web ini mengembalikan nama exact, tapi kalau user ngetik manual bisa sebagian
            let matchRelasi = !fRelasi || (d.relasi && d.relasi.toLowerCase() === fRelasi);
            return matchKode && matchPerkiraan && matchRelasi;
        });
    }
    
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:#888;">Tidak ada transaksi jurnal pada rentang ini.</td></tr>`;
        document.getElementById('jurnal-total-debit').innerText = "0";
        document.getElementById('jurnal-total-kredit').innerText = "0";
        document.getElementById('jurnal-total-saldo').innerText = "0";
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
        
        // Format nominal mentah di dalam deskripsi (seperti @5000 atau Rp 50000)
        let deskripsiFormat = d.deskripsi ? d.deskripsi.replace(/(@|Rp\s*)(\d+)/g, (match, prefix, numStr) => {
            return prefix + nf.format(Number(numStr));
        }) : "";

        // Gabungkan Uraian Dasar
        let uraian = `${d.nama_akun}. ${tglUraian} ${d.relasi ? d.relasi + ' ' : ''}${deskripsiFormat}`;
        
        // 🔥 INJEKSI DETAIL NOTA PIUTANG JIKA INI ADALAH PEMBAYARAN KAS
        if (d.id_jurnal && d.id_jurnal.startsWith('CF-') && piutangParsed && d.relasi && piutangParsed[d.relasi] && piutangParsed[d.relasi].riwayat_all) {
            let nominalCari = debNum > 0 ? debNum : kreNum;
            // Cari pembayaran yang cocok di riwayat_all (berdasarkan tgl & nominal)
            // Karena mungkin ada double, kita cari yang belum diproses (kita tandai sementara)
            let matchedBayar = piutangParsed[d.relasi].riwayat_all.find(b => b.tgl === d.tanggal && b.nominal === nominalCari && !b._jurnal_used);
            
            if (matchedBayar && matchedBayar.detailPotongan && matchedBayar.detailPotongan.length > 0) {
                matchedBayar._jurnal_used = true; // Tandai agar tidak ganda jika ada pembayaran kembar
                let teksPotong = matchedBayar.detailPotongan.map(p => {
                    return `Nota ${p.tglNota} (Rp ${nf.format(p.jumlah)})`;
                }).join('; ');
                
                uraian += ` [Memotong: ${teksPotong}]`;
            }
        }
        
        let bg = index % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";
        
        html += `<tr style="${bg}">
            <td style="padding:10px;">${tglStr}</td>
            <td style="padding:10px; text-align:center;">${kodeDepan}</td>
            <td style="padding:10px;">${d.nama_akun}</td>
            <td style="padding:10px;">${d.relasi || ''}</td>
            <td style="padding:10px; line-height:1.4;">${uraian}</td>
            <td style="padding:10px; text-align:right;">${debStr}</td>
            <td style="padding:10px; text-align:right;">${kreStr}</td>
            <td style="padding:10px; text-align:right; font-weight:bold;">${saldoStr}</td>
        </tr>`;
        
        tDebit += debNum;
        tKredit += kreNum;
    });

    tbody.innerHTML = html;
    document.getElementById('jurnal-total-debit').innerText = nf.format(tDebit);
    document.getElementById('jurnal-total-kredit').innerText = nf.format(tKredit);
    document.getElementById('jurnal-total-saldo').innerText = nf.format(tDebit - tKredit);
    
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

function exportExcelJurnal() {
    if (jurnalDataGlobal.length === 0) {
        alert("Tidak ada data untuk diexport!");
        return;
    }
    alert("Fitur Export Excel Jurnal akan dikembangkan di tahap selanjutnya!");
}

// Tambahkan Event Listener Search Realtime
document.getElementById('jurnal-kode')?.addEventListener('change', () => renderJurnal(jurnalDataGlobal));
document.getElementById('jurnal-perkiraan')?.addEventListener('input', () => renderJurnal(jurnalDataGlobal));
document.getElementById('jurnal-relasi')?.addEventListener('input', () => renderJurnal(jurnalDataGlobal));

// ==========================================
// SUB-MENU: KARTU PIUTANG KONSUMEN
// ==========================================

function switchTabJurnal(tab) {
    let btnUmum = document.getElementById('tab-jurnal-umum');
    let btnKP = document.getElementById('tab-jurnal-kartu-piutang');
    let viewUmum = document.getElementById('view-jurnal-umum');
    let viewKP = document.getElementById('view-jurnal-kartu-piutang');

    if (tab === 'umum') {
        btnUmum?.classList.add('active');
        btnKP?.classList.remove('active');
        viewUmum?.classList.remove('hidden');
        viewKP?.classList.add('hidden');
    } else if (tab === 'kartu-piutang') {
        btnKP?.classList.add('active');
        btnUmum?.classList.remove('active');
        viewKP?.classList.remove('hidden');
        viewUmum?.classList.add('hidden');

        let inp = document.getElementById('kp-filter-konsumen');
        if (inp && !inp.value.trim()) {
            setTimeout(() => inp.focus(), 150);
        }
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
                uang.detailPotongan.push({ tglNota: matched.tgl, jumlah: dipotong, isTunai: true });
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
            uang.detailPotongan.push({ tglNota: nota.tgl, jumlah: dipotong });
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

    let allEventDates = Array.from(new Set(timeline.map(ev => ev.date))).sort();
    if (periode !== 'ALL') {
        allEventDates = allEventDates.filter(d => d.startsWith(periode));
    }

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
        if (periode === 'ALL' || ev.date.startsWith(periode)) {
            let count = 0;
            if (ev.type === 'NOTA') {
                count += (ev.nota.items ? ev.nota.items.length : 1) + (ev.attachedPayments ? ev.attachedPayments.length : 0);
            } else {
                count += 1;
            }
            dateCounts[ev.date] = (dateCounts[ev.date] || 0) + count;
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

    // Hitung Saldo Awal Tahun jika bukan ALL
    let saldoAwalTahun = 0;
    if (periode !== 'ALL') {
        let tgtStart = `${periode}-01-01`;
        tagihanArr.filter(t => t.tgl < tgtStart).forEach(t => saldoAwalTahun += t.nominal);
        bayarArr.filter(b => b.tgl < tgtStart).forEach(b => saldoAwalTahun -= b.nominal);
    }

    let runningSaldo = saldoAwalTahun;
    let periodTagihan = 0;
    let periodBayar = 0;
    let rowsHtml = '';
    let rowCount = 0;

    let saldoSebelumFirstSelected = saldoAwalTahun;
    if (isPartialDateFilter && firstSelectedDate) {
        timeline.forEach(event => {
            let eventYear = event.date.split('-')[0];
            let isWithin = (periode === 'ALL' || eventYear === periode);
            if (isWithin && event.date < firstSelectedDate) {
                if (event.type === 'NOTA') {
                    event.nota.items.forEach(it => saldoSebelumFirstSelected += it.nominal);
                    if (event.attachedPayments) {
                        event.attachedPayments.forEach(b => saldoSebelumFirstSelected -= b.nominal);
                    }
                } else if (event.type === 'STANDALONE_PAYMENT') {
                    saldoSebelumFirstSelected -= event.payment.nominal;
                }
            }
        });
    }

    // Baris Saldo Awal
    if (isPartialDateFilter && firstSelectedDate && selectedDates.size > 0) {
        let saldoStr = saldoSebelumFirstSelected < 0 ? `-Rp ${nf.format(Math.abs(saldoSebelumFirstSelected))}` : `Rp ${nf.format(saldoSebelumFirstSelected)}`;
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
    } else if (periode !== 'ALL' && (!isPartialDateFilter || selectedDates.size > 0)) {
        let saldoAwalStr = saldoAwalTahun < 0 ? `-Rp ${nf.format(Math.abs(saldoAwalTahun))}` : `Rp ${nf.format(saldoAwalTahun)}`;
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

    if (selectedDates.size === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:#64748b; font-style:italic;">Tidak ada tanggal yang dipilih pada filter tanggal.</td></tr>`;
        if (tfoot) {
            tfoot.innerHTML = `
                <tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">
                    <td colspan="2" style="text-align:right; padding:12px 10px; color:#334155; font-size:12px; font-weight:800; text-transform:uppercase;">TOTAL MUTASI:</td>
                    <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp 0</td>
                    <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp 0</td>
                    <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:13px; font-weight:800;">Rp 0</td>
                </tr>
            `;
        }
        tableContainer?.classList.remove('hidden');
        emptyState?.classList.add('hidden');
        return;
    }

    // Render Events
    timeline.forEach(event => {
        let eventYear = event.date.split('-')[0];
        let isWithin = (periode === 'ALL' || eventYear === periode);
        if (!isWithin) return;

        let isDateSelected = selectedDates.has(event.date);

        if (event.type === 'NOTA') {
            event.nota.items.forEach(it => {
                runningSaldo += it.nominal;
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
            });

            if (event.attachedPayments && event.attachedPayments.length > 0) {
                event.attachedPayments.forEach(b => {
                    runningSaldo -= b.nominal;
                    if (isDateSelected) {
                        periodBayar += b.nominal;
                        rowCount++;

                        let bg = rowCount % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";
                        let linkBukti = b.bukti_url 
                            ? `<a href="${b.bukti_url}" target="_blank" style="margin-left:6px; color:#2563eb; text-decoration:none; display:inline-flex; align-items:center; gap:2px; font-size:10px; font-weight:600;"><span class="material-symbols-outlined" style="font-size:13px;">receipt_long</span> Bukti</a>` 
                            : '';
                        
                        let ketBayar = `
                            <div style="font-weight:700; color:#15803d; display:flex; align-items:center;">
                                <span>Pembayaran (${escapeHtmlKP(b.metode)})</span>
                                ${linkBukti}
                            </div>
                        `;

                        if (b.detailPotongan && b.detailPotongan.length > 0) {
                            ketBayar += `<div style="font-size:10px; color:#64748b; margin-top:2px;">Memotong Nota: `;
                            let potTxt = b.detailPotongan.map(p => {
                                if (p.isTunai) return `Tgl ${fmtTglKP(p.tglNota)} (Tunai Langsung)`;
                                return `Tgl ${fmtTglKP(p.tglNota)} (Rp ${nf.format(p.jumlah)})`;
                            }).join(', ');
                            ketBayar += potTxt + `</div>`;
                        }

                        if (b.keterangan && b.keterangan !== '-') {
                            ketBayar += `<div style="font-size:10px; color:#64748b; font-style:italic; margin-top:1px;">${escapeHtmlKP(b.keterangan)}</div>`;
                        }

                        let saldoDisplay = runningSaldo < 0 ? `-Rp ${nf.format(Math.abs(runningSaldo))}` : `Rp ${nf.format(runningSaldo)}`;
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
                });
            }
        } else if (event.type === 'STANDALONE_PAYMENT') {
            let b = event.payment;
            runningSaldo -= b.nominal;
            if (isDateSelected) {
                periodBayar += b.nominal;
                rowCount++;

                let bg = rowCount % 2 === 0 ? "background:#ffffff;" : "background:#f8fafc;";
                let linkBukti = b.bukti_url 
                    ? `<a href="${b.bukti_url}" target="_blank" style="margin-left:6px; color:#2563eb; text-decoration:none; display:inline-flex; align-items:center; gap:2px; font-size:10px; font-weight:600;"><span class="material-symbols-outlined" style="font-size:13px;">receipt_long</span> Bukti</a>` 
                    : '';

                let ketBayar = `
                    <div style="font-weight:700; color:#0369a1; display:flex; align-items:center;">
                        <span>Pembayaran / Deposit (${escapeHtmlKP(b.metode)})</span>
                        ${linkBukti}
                    </div>
                `;

                if (b.keterangan && b.keterangan !== '-') {
                    ketBayar += `<div style="font-size:10px; color:#64748b; margin-top:2px;">${escapeHtmlKP(b.keterangan)}</div>`;
                }

                let saldoDisplay = runningSaldo < 0 ? `-Rp ${nf.format(Math.abs(runningSaldo))}` : `Rp ${nf.format(runningSaldo)}`;
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
    });

    if (tbody) {
        if (rowCount === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:25px; color:#64748b; font-style:italic;">Tidak ada transaksi dalam filter yang dipilih.</td></tr>`;
        } else {
            tbody.innerHTML = rowsHtml;
        }
    }

    // TFoot
    if (tfoot) {
        let labelTFoot = isPartialDateFilter 
            ? 'TOTAL MUTASI (TANGGAL TERPILIH):' 
            : `TOTAL MUTASI ${periode === 'ALL' ? 'KESELURUHAN' : 'TAHUN ' + periode}:`;

        let finalSaldoStr = runningSaldo < 0 ? `-Rp ${nf.format(Math.abs(runningSaldo))}` : `Rp ${nf.format(runningSaldo)}`;
        tfoot.innerHTML = `
            <tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">
                <td colspan="2" style="text-align:right; padding:12px 10px; color:#334155; font-size:12px; font-weight:800; text-transform:uppercase;">${labelTFoot}</td>
                <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp ${nf.format(periodTagihan)}</td>
                <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:12px; font-weight:800;">Rp ${nf.format(periodBayar)}</td>
                <td style="text-align:right; padding:12px 10px; color:#1e293b; font-size:13px; font-weight:800;">${finalSaldoStr}</td>
            </tr>
        `;
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
