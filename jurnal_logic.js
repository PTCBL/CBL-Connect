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

function exportExcelJurnal(targetFormat = 'xlsx') {
    if (!jurnalDataGlobal || jurnalDataGlobal.length === 0) {
        alert("Tidak ada data untuk diexport!");
        return;
    }

    // Ambil data yang terfilter saat ini (sama persis dengan yang tampil di tabel)
    let fKode = document.getElementById('jurnal-kode')?.value || '';
    let fPerkiraan = (document.getElementById('jurnal-perkiraan')?.value || '').toLowerCase();
    let fRelasi = (document.getElementById('jurnal-relasi')?.value || '').toLowerCase();

    let filtered = jurnalDataGlobal;
    if (fKode || fPerkiraan || fRelasi) {
        filtered = jurnalDataGlobal.filter(d => {
            let matchKode = !fKode || (d.kode_akun && d.kode_akun.startsWith(fKode));
            let matchPerkiraan = !fPerkiraan || (d.nama_akun && d.nama_akun.toLowerCase().includes(fPerkiraan));
            let matchRelasi = !fRelasi || (d.relasi && d.relasi.toLowerCase() === fRelasi);
            return matchKode && matchPerkiraan && matchRelasi;
        });
    }

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
            if (piutangParsed[rel] && piutangParsed[rel].riwayat_all) {
                cloneRiwayat[rel] = piutangParsed[rel].riwayat_all.map(b => ({ ...b, _exp_used: false }));
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

        let deskripsiFormat = d.deskripsi ? d.deskripsi.replace(/(@|Rp\s*)(\d+)/g, (match, prefix, numStr) => {
            return prefix + nf.format(Number(numStr));
        }) : "";

        let uraian = `${d.nama_akun}. ${tglUraian} ${d.relasi ? d.relasi + ' ' : ''}${deskripsiFormat}`;

        if (d.id_jurnal && d.id_jurnal.startsWith('CF-') && cloneRiwayat[d.relasi]) {
            let nominalCari = debNum > 0 ? debNum : kreNum;
            let matchedBayar = cloneRiwayat[d.relasi].find(b => b.tgl === d.tanggal && b.nominal === nominalCari && !b._exp_used);
            if (matchedBayar && matchedBayar.detailPotongan && matchedBayar.detailPotongan.length > 0) {
                matchedBayar._exp_used = true;
                let teksPotong = matchedBayar.detailPotongan.map(p => `Nota ${p.tglNota} (Rp ${nf.format(p.jumlah)})`).join('; ');
                uraian += ` [Memotong: ${teksPotong}]`;
            }
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

// Tambahkan Event Listener Search Realtime
document.getElementById('jurnal-kode')?.addEventListener('change', () => renderJurnal(jurnalDataGlobal));
document.getElementById('jurnal-perkiraan')?.addEventListener('input', () => renderJurnal(jurnalDataGlobal));
document.getElementById('jurnal-relasi')?.addEventListener('input', () => renderJurnal(jurnalDataGlobal));

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
                uang.detailPotongan.push({ tglNota: matched.tgl, jumlah: dipotong, isTunai: true });
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
                uang.detailPotongan.push({ tglNota: matched.tgl, jumlah: dipotong, isDiskon: true });
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

        let [resPakan, resCF] = await Promise.all([
            fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.desc,id.desc`, { headers }),
            fetch(`${SUPA_URL}/rest/v1/cashflow?tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.desc,id.desc`, { headers })
        ]);

        let rowsPakan = resPakan.ok ? await resPakan.json() : [];
        let rowsCF = resCF.ok ? await resCF.json() : [];

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
    }

    currentOpenFilter.distinctValues = Object.values(distinctMap);

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
    let totalKg = filtered.reduce((acc, c) => acc + (Number(c.qty) || 0), 0);
    let totalHpp = filtered.reduce((acc, c) => acc + (Number(c.total_hpp) || 0), 0);
    let avgHpp = totalKg > 0 ? Math.round(totalHpp / totalKg) : 0;
    let countDefisit = filtered.filter(c => {
        let isOng = (c.pakan || '').toLowerCase().includes('ongkir');
        if (isOng) return false;
        return (Number(c.qty_defisit) || 0) > 0 || Number(c.total_hpp) === 0;
    }).length;

    document.getElementById('hpp-kpi-val-1').innerText = nf.format(totalKg) + ' Kg';
    document.getElementById('hpp-kpi-val-2').innerText = 'Rp ' + nf.format(totalHpp);
    document.getElementById('hpp-kpi-val-3').innerText = 'Rp ' + nf.format(avgHpp) + ' / Kg';
    document.getElementById('hpp-kpi-val-4').innerHTML = countDefisit > 0 
        ? `<span style="color:#dc2626; font-weight:bold;">${countDefisit} Tx Defisit</span>` 
        : `<span style="color:#15803d; font-weight:bold;">Normal</span>`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:30px; color:#64748b;">Tidak ada data pengeluaran HPP yang sesuai filter.</td></tr>`;
        return;
    }

    let html = "";
    filtered.forEach((r, idx) => {
        let tglStr = r.tanggal ? r.tanggal.split('-').reverse().join('/') : '-';
        let qty = Number(r.qty) || 0;
        let hs = Number(r.harga_satuan) || 0;
        let hpp = Number(r.total_hpp) || 0;
        let unitHpp = qty > 0 && hpp > 0 ? Math.round(hpp / qty) : 0;
        let margin = hs > 0 && unitHpp > 0 ? (hs - unitHpp) : 0;
        let marginPct = hs > 0 && margin > 0 ? ((margin / hs) * 100).toFixed(1) + '%' : '-';
        let isOngkir = (r.pakan || '').toLowerCase().includes('ongkir');

        // Silsilah Batch
        let matchedBatch = hppInflowGlobal.find(b => b.pakan === r.pakan && (b.cabang === r.cabang || !b.cabang));
        let silsilahText = "";
        if (isOngkir) {
            silsilahText = `<span style="color:#64748b; font-style:italic;">Bukan stok fisik (Jasa Ongkir)</span>`;
        } else if (unitHpp > 0 && matchedBatch) {
            silsilahText = `• Batch #${matchedBatch.id} (${matchedBatch.tanggal_masuk}) @${nf.format(matchedBatch.hpp || unitHpp)}`;
        } else if (unitHpp > 0) {
            silsilahText = `• FIFO Stok Masuk @${nf.format(unitHpp)}`;
        } else {
            silsilahText = `<span style="color:#dc2626; font-weight:bold;">Tidak ada batch aktif (Stok defisit)</span>`;
        }

        let statusBadge = "";
        if (isOngkir) {
            statusBadge = `<span style="background:#e2e8f0; color:#475569; padding:2px 8px; border-radius:10px; font-weight:bold; font-size:10px;">Non-Stok</span>`;
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
            <td style="padding:8px; text-align:right; color:#c2410c; font-weight:bold;">${hpp > 0 ? 'Rp ' + nf.format(hpp) : 'Rp 0'}</td>
            <td style="padding:8px; text-align:right;">${unitHpp > 0 ? 'Rp ' + nf.format(unitHpp) : '-'}</td>
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
    let totalAsetSisa = batchAktif.reduce((acc, b) => acc + ((Number(b.qty_sisa) || 0) * (Number(b.hpp) || 0)), 0);

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
        let hpp = Number(b.hpp) || 0;
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

        // Fetch view_jurnal_umum, transaksi_pakan (keluar), dan cashflow (keluar) secara paralel
        let [resJurnal, resTrxOut, resCF] = await Promise.all([
            fetch(`${SUPA_URL}/rest/v1/view_jurnal_umum?tanggal=gte.${startDate}&tanggal=lte.${endDate}&order=tanggal.asc`, { headers }),
            fetch(`${SUPA_URL}/rest/v1/transaksi_pakan?tanggal=gte.${startDate}&tanggal=lte.${endDate}&status=ilike.*keluar*&order=tanggal.asc`, { headers }),
            fetch(`${SUPA_URL}/rest/v1/cashflow?tanggal=gte.${startDate}&tanggal=lte.${endDate}&jenis=ilike.*keluar*&order=tanggal.asc`, { headers })
        ]);

        let jData = resJurnal.ok ? await resJurnal.json() : [];
        let trxData = resTrxOut.ok ? await resTrxOut.json() : [];
        let cfData = resCF.ok ? await resCF.json() : [];

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

        // Price lookup dari transaksi komersial untuk menghitung harga jual normal bagi pemakaian kandang
        let priceLookup = {};
        trxData.forEach(t => {
            let pkn = (t.pakan || '').trim();
            let hs = Number(t.harga_satuan) || 0;
            if (hs > 0 && pkn && !priceLookup[pkn]) {
                priceLookup[pkn] = hs;
            }
        });

        // Helper untuk cek apakah baris transaksi adalah transfer logistik antar gudang / drop ke kandang
        function isLogistikTransferRow(t) {
            let rel = (t.relasi || '').trim().toLowerCase();
            let cat = (t.catatan || '').toLowerCase();
            if (rel === 'kandang' || rel === 'kandang pm' || rel === 'kandang spn' || rel === 'kandang rph') return true;
            if (rel === 'spn' || rel === 'pm' || rel === 'rph' || rel === 'mutasi') return true;
            if (cat.includes('[auto mutasi]') || cat.includes('kiriman dari') || cat.includes('mutasi antar gudang')) return true;
            return false;
        }

        // Helper untuk cek apakah baris transaksi adalah pengeluaran bahan baku untuk digiling di Gudang SPN
        function isBahanBakuGilinganRow(t) {
            let cab = (t.cabang || '').trim().toUpperCase();
            let rel = (t.relasi || '').trim().toUpperCase();
            let cat = (t.catatan || '').toLowerCase();
            if (cab.includes('SPN') && !cab.includes('KANDANG')) {
                if (rel === 'RL' || rel === 'RD' || rel === 'DARBUN' || rel === 'LAKTASI' || 
                    rel.includes('GILING') || cat.includes('giling')) {
                    return true;
                }
            }
            return false;
        }

        // Helper untuk mendeteksi konsumsi ternak internal riil (dan cabang tujuannya)
        function getKonsumsiTernakInfo(t) {
            if (isLogistikTransferRow(t) || isBahanBakuGilinganRow(t)) return null;

            let rel = (t.relasi || '').trim();
            let relLower = rel.toLowerCase();
            let cab = (t.cabang || '').trim().toLowerCase();
            let pkn = (t.pakan || '').trim().toLowerCase();

            // 1. KANDANG SPN (Sapi Perah: Laktasi, Bunting / Darbun, Dara, Pedet SPN, Perah)
            let isSPNGroup = cab.includes('spn') || 
                             relLower.includes('laktasi') || 
                             relLower.includes('bunting') || 
                             relLower.includes('darbun') || 
                             relLower.includes('perah') ||
                             pkn.includes('laktasi') ||
                             pkn.includes('darbun');

            if (isSPNGroup) {
                let unit = rel;
                if (relLower.includes('laktasi') || pkn.includes('laktasi')) unit = 'Laktasi (RL)';
                else if (relLower.includes('bunting') || relLower.includes('darbun') || pkn.includes('darbun')) unit = 'Bunting / Dara (RD)';
                else if (relLower.includes('pedet')) unit = 'Pedet SPN';
                else if (relLower.includes('perah') || relLower === 'spn') unit = 'Sapi Perah (SPN)';
                else if (!unit || unit.toLowerCase() === 'kandang') unit = 'Sapi Perah (SPN)';
                return { cabangKey: 'SPN', unit: unit };
            }

            // 2. KANDANG RPH (Sapi Transit / Potong)
            let isRPHGroup = cab.includes('rph') || relLower.includes('transit');
            if (isRPHGroup && (relLower.includes('transit') || cab.includes('kandang'))) {
                let unit = relLower.includes('transit') ? 'Sapi Transit' : rel;
                return { cabangKey: 'RPH', unit: unit };
            }

            // 3. KANDANG PM (Pembibitan Manoko: Kapalang, Dewasa, Jantan, BX, Domba, Pembibitan, Pedet PM)
            let pmKelompok = ['kapalang', 'dewasa', 'jantan', 'bx', 'domba', 'pembibitan', 'pedet', 'kambing'];
            let isPMMatch = pmKelompok.includes(relLower);
            let isPMCabang = cab.includes('kandang pm') || (cab.includes('kandang') && !cab.includes('spn') && !cab.includes('rph'));

            if (isPMMatch || isPMCabang) {
                if (relLower === 'kandang') return null; // Drop logistik umum jangan masuk
                let unit = rel;
                if (relLower === 'kapalang' || (isPMCabang && relLower.includes('kapalang'))) unit = 'Kapalang';
                else if (relLower === 'dewasa' || (isPMCabang && relLower.includes('dewasa'))) unit = 'Dewasa';
                else if (relLower === 'jantan' || (isPMCabang && relLower.includes('jantan'))) unit = 'Jantan';
                else if (relLower === 'bx' || (isPMCabang && relLower.includes('bx'))) unit = 'BX';
                else if (relLower === 'domba' || (isPMCabang && relLower.includes('domba'))) unit = 'Domba';
                else if (relLower === 'pembibitan' || (isPMCabang && relLower.includes('pembibitan'))) unit = 'Pembibitan';
                else if (relLower === 'pedet' || (isPMCabang && relLower.includes('pedet'))) unit = 'Pedet PM';
                else if (!isPMMatch && !isPMCabang) return null;
                return { cabangKey: 'PM', unit: unit };
            }

            return null;
        }

        let pemakaianKandangDetail = {};
        let pemakaianKandangPerCabang = {
            'PM': { key: 'PM', label: 'KANDANG PM (Pembibitan Manoko)', items: {}, totalQty: 0, totalHpp: 0, totalJual: 0 },
            'SPN': { key: 'SPN', label: 'KANDANG SPN (Sapi Perah)', items: {}, totalQty: 0, totalHpp: 0, totalJual: 0 },
            'RPH': { key: 'RPH', label: 'KANDANG RPH', items: {}, totalQty: 0, totalHpp: 0, totalJual: 0 }
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
            let hpp = Number(t.total_hpp) || 0;
            let totalNilai = qty * hs;

            let ternakInfo = getKonsumsiTernakInfo(t);

            if (ternakInfo) {
                // Alokasi Konsumsi Pakan Ternak Sendiri (Holding Internal)
                let { cabangKey, unit } = ternakInfo;
                let targetBranch = pemakaianKandangPerCabang[cabangKey] || pemakaianKandangPerCabang['PM'];

                if (!targetBranch.items[unit]) {
                    targetBranch.items[unit] = {
                        unit: unit,
                        totalQty: 0,
                        totalHpp: 0,
                        totalJual: 0
                    };
                }
                targetBranch.items[unit].totalQty += qty;
                targetBranch.items[unit].totalHpp += hpp;

                // Flat detail (backward compatibility)
                if (!pemakaianKandangDetail[unit]) {
                    pemakaianKandangDetail[unit] = { unit: unit, totalQty: 0, totalHpp: 0, totalJual: 0 };
                }
                pemakaianKandangDetail[unit].totalQty += qty;
                pemakaianKandangDetail[unit].totalHpp += hpp;

                // Hitung nilai jual normal: pakai harga_satuan jika ada (>0), atau fallback priceLookup
                let hargaJualAcuan = hs > 0 ? hs : (priceLookup[pkn] || (hpp > 0 && qty > 0 ? Math.round(hpp / qty * 1.1) : 0));
                let nilaiJual = (qty * hargaJualAcuan);
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
        cfData.forEach(c => {
            let rel = (c.relasi || '').trim();
            if (rel.toLowerCase().includes('bapera')) return;
            let kat = (c.kategori || '').trim() || 'Operasional Lainnya';
            let nom = Number(c.nominal) || 0;
            bebanOperasionalMap[kat] = (bebanOperasionalMap[kat] || 0) + nom;
        });

        // Fallback beban jika cfData kosong
        if (Object.keys(bebanOperasionalMap).length === 0) {
            jData.forEach(d => {
                let deb = Number(d.debit) || 0;
                let nama = (d.nama_akun || '').trim();
                let kode = (d.kode_akun || '').charAt(0);
                if (kode === '5' && nama !== 'Biaya Diskon & Lain-lain' && !nama.toLowerCase().includes('pemakaian pakan')) {
                    bebanOperasionalMap[nama] = (bebanOperasionalMap[nama] || 0) + deb;
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
            grossProfitKomersial,
            grossMarginKomersial,
            bebanOperasionalMap,
            totalBebanOperasionalGudang,
            labaBersihDivisiPakan,
            netMarginDivisiPakan,
            pemakaianKandangDetail,
            pemakaianKandangPerCabang,
            totalPemakaianQty,
            totalPemakaianHpp,
            totalPemakaianJual,
            totalSubsidiInternal,
            labaBersihKonsolidasian
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

    // Rincian Beban Operasional Gudang & Lapangan
    let htmlBiayaOperasional = "";
    Object.keys(lr.bebanOperasionalMap).sort().forEach(kat => {
        htmlBiayaOperasional += `
            <div style="display:flex; justify-content:space-between; padding:4px 0 4px 20px; font-size:12px; color:#475569;">
                <span>• ${escapeHtmlKP(kat)}</span>
                <span style="font-weight:600;">Rp ${nf.format(lr.bebanOperasionalMap[kat])}</span>
            </div>
        `;
    });

    // Tabel Pemakaian Pakan Ternak Sendiri (2 Harga: HPP vs Jual)
    let activeBranches = Object.values(lr.pemakaianKandangPerCabang || {}).filter(b => Object.keys(b.items).length > 0);
    let htmlTablePemakaian = "";
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
                        <td style="padding:6px 8px; text-align:right; font-weight:bold; color:#c2410c;">Rp ${nf.format(u.totalHpp)}</td>
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

    cont.innerHTML = `
        <div style="text-align:center; border-bottom:2px solid #1e3a8a; padding-bottom:15px; margin-bottom:20px;">
            <h2 style="margin:0; font-size:20px; color:#1e3a8a; text-transform:uppercase; letter-spacing:0.5px;">PT CITRA BANGUN LESTARI</h2>
            <div style="font-size:15px; font-weight:bold; color:#334155; margin-top:4px;">LAPORAN LABA RUGI KOMPREHENSIF (MULTI-STEP)</div>
            <div style="font-size:12px; color:#64748b; margin-top:2px;">Periode: <b>${lr.periodeLabel}</b></div>
        </div>

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
            <div style="display:flex; justify-content:space-between; padding:4px 0 4px 10px; font-size:13px; color:#b91c1c;">
                <span>Beban Pokok Penjualan Pakan Komersial</span>
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
        <div style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; font-size:15px; font-weight:bold; background:#ecfdf5; border:2px solid #10b981; border-radius:8px; color:#065f46; margin-bottom:25px;">
            <div>
                <div>LABA BERSIH OPERASIONAL DIVISI PAKAN (STANDALONE SURPLUS)</div>
                <div style="font-size:11px; font-weight:normal; color:#047857; margin-top:2px;">
                    Margin Operasional Divisi: <b>${lr.netMarginDivisiPakan}%</b> dari Omzet Komersial.
                </div>
            </div>
            <div style="font-size:22px; font-weight:900;">Rp ${nf.format(lr.labaBersihDivisiPakan)}</div>
        </div>

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
                <b>Catatan Akuntansi Pemeliharaan:</b> Pakan yang dikirim ke unit <b>SPN (Sapi Perah)</b> menghasilkan pendapatan penjualan susu harian yang dicatat pada pembukuan terpisah divisi SPN. Konsumsi pada kandang <b>Kapalang / PM</b> terkonversi menjadi pertambahan bobot daging ternak (ADG). Selisih nilai <b>+Rp ${nf.format(lr.totalSubsidiInternal)}</b> adalah efisiensi penghematan modal yang dinikmati grup peternakan.
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
    let filename = `Laba_Rugi_CBL_${lr.periodeLabel.replace(/\s+/g, '_')}`;

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
    rows.push({ 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' });

    rows.push({ 'Pos Akun': 'IV. ALOKASI KONSUMSI PAKAN TERNAK SENDIRI', 'Keterangan': '', 'Jumlah (Rp)': '' });
    let activeBranches = Object.values(lr.pemakaianKandangPerCabang || {}).filter(b => Object.keys(b.items).length > 0);
    if (activeBranches.length > 0) {
        activeBranches.forEach(branch => {
            rows.push({ 'Pos Akun': `[${branch.label}]`, 'Keterangan': '', 'Jumlah (Rp)': '' });
            Object.values(branch.items).sort((a, b) => b.totalHpp - a.totalHpp).forEach(u => {
                rows.push({
                    'Pos Akun': `  • ${u.unit} (${u.totalQty.toLocaleString('id-ID')} Kg)`,
                    'Keterangan': `HPP: Rp ${u.totalHpp.toLocaleString('id-ID')} | Pasar: Rp ${u.totalJual.toLocaleString('id-ID')}`,
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
    } else {
        Object.values(lr.pemakaianKandangDetail).forEach(u => {
            rows.push({
                'Pos Akun': `Pemakaian ${u.unit} (${u.totalQty} Kg)`,
                'Keterangan': `HPP: Rp ${u.totalHpp.toLocaleString('id-ID')} | Pasar: Rp ${u.totalJual.toLocaleString('id-ID')}`,
                'Jumlah (Rp)': -u.totalHpp
            });
        });
    }

    rows.push({ 'Pos Akun': 'TOTAL ALOKASI MODAL PAKAN INTERNAL', 'Keterangan': `Efisiensi Subsidi: Rp ${lr.totalSubsidiInternal.toLocaleString('id-ID')}`, 'Jumlah (Rp)': -lr.totalPemakaianHpp });
    rows.push({ 'Pos Akun': '', 'Keterangan': '', 'Jumlah (Rp)': '' });
    rows.push({ 'Pos Akun': 'V. HASIL BERSIH KONSOLIDASIAN HOLDING', 'Keterangan': 'Laba Bersih Divisi - Modal Pemakaian Internal', 'Jumlah (Rp)': lr.labaBersihKonsolidasian });

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

        // Tarik saldo kumulatif jurnal hingga posisi endDate
        let res = await fetch(`${SUPA_URL}/rest/v1/view_jurnal_umum?tanggal=lte.${endDate}&order=tanggal.asc`, { headers });
        let jData = res.ok ? await res.json() : [];

        // Hitung Saldo Akun Kumulatif
        let saldoKas = 0;
        let saldoPiutang = 0;
        let saldoPersediaan = 0;
        let saldoHutang = 0;

        let totalRev = 0;
        let totalExp = 0;

        jData.forEach(d => {
            let deb = Number(d.debit) || 0;
            let kre = Number(d.kredit) || 0;
            let nama = (d.nama_akun || '').trim();
            let kode = (d.kode_akun || '').charAt(0);

            if (nama === 'Kas') {
                saldoKas += (deb - kre);
            } else if (nama === 'Piutang Pakan') {
                saldoPiutang += (deb - kre);
            } else if (nama === 'Persediaan Pakan') {
                saldoPersediaan += (deb - kre);
            } else if (nama === 'Hutang Pakan') {
                saldoHutang += (kre - deb);
            }

            // Hitung Laba Bersih Berjalan (Akun 4 & 5)
            if (kode === '4') {
                if (nama === 'Pendapatan Penjualan') totalRev += kre;
                else if (nama === 'Retur Penjualan') totalRev -= deb;
                else if (nama === 'Harga Pokok Penjualan (HPP)') totalExp += deb;
            } else if (kode === '5') {
                totalExp += deb;
            }
        });

        let totalAktiva = saldoKas + saldoPiutang + saldoPersediaan;
        let totalKewajiban = saldoHutang;

        // Laba Bersih Berjalan dari pembukuan
        let labaBerjalan = totalRev - totalExp;

        // Ekuitas Penyeimbang (Modal Awal & Laba Ditahan)
        let ekuitasModal = totalAktiva - totalKewajiban - labaBerjalan;
        let totalEkuitas = ekuitasModal + labaBerjalan;
        let totalPasiva = totalKewajiban + totalEkuitas;

        let selisih = totalAktiva - totalPasiva;

        neracaDataGlobal = {
            asOfLabel,
            saldoKas,
            saldoPiutang,
            saldoPersediaan,
            totalAktiva,
            saldoHutang,
            totalKewajiban,
            ekuitasModal,
            labaBerjalan,
            totalEkuitas,
            totalPasiva,
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

function renderNeraca(n) {
    let cont = document.getElementById('neraca-report-container');
    if (!cont || !n) return;

    let nf = new Intl.NumberFormat('id-ID');
    let isBalance = Math.abs(n.selisih) < 1;

    cont.innerHTML = `
        <div style="text-align:center; border-bottom:2px solid #1e3a8a; padding-bottom:15px; margin-bottom:15px;">
            <h2 style="margin:0; font-size:20px; color:#1e3a8a; text-transform:uppercase; letter-spacing:0.5px;">PT CITRA BANGUN LESTARI</h2>
            <div style="font-size:15px; font-weight:bold; color:#334155; margin-top:4px;">LAPORAN POSISI KEUANGAN (NERACA)</div>
            <div style="font-size:12px; color:#64748b; margin-top:2px;">Posisi Per: <b>${n.asOfLabel}</b></div>
        </div>

        <!-- Status Balance Banner -->
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 15px; border-radius:6px; margin-bottom:20px; font-size:13px; font-weight:bold; ${isBalance ? 'background:#ecfdf5; color:#065f46; border:1px solid #a7f3d0;' : 'background:#fef2f2; color:#991b1b; border:1px solid #fecaca;'}">
            <span>${isBalance ? 'STATUS: NERACA 100% BALANCE (AKTIVA = PASIVA)' : 'STATUS: PERHATIAN ADA SELISIH'}</span>
            <span>Selisih: Rp ${nf.format(n.selisih)}</span>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:25px;">
            <!-- BAGIAN KIRI: AKTIVA (ASET) -->
            <div>
                <div style="font-weight:bold; font-size:14px; color:#1e3a8a; border-bottom:2px solid #0284c7; padding-bottom:6px; margin-bottom:10px;">
                    AKTIVA (ASET) — [KODE 1]
                </div>
                
                <div style="font-weight:600; font-size:12px; color:#475569; margin-bottom:6px;">Aset Lancar:</div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Kas & Bank</span>
                    <span style="font-weight:600;">Rp ${nf.format(n.saldoKas)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Piutang Pakan Peternak</span>
                    <span style="font-weight:600;">Rp ${nf.format(n.saldoPiutang)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Persediaan Pakan di Gudang (FIFO)</span>
                    <span style="font-weight:600;">Rp ${nf.format(n.saldoPersediaan)}</span>
                </div>

                <div style="display:flex; justify-content:space-between; padding:12px 10px; font-size:15px; font-weight:bold; background:#e0f2fe; border-radius:6px; margin-top:25px; border-top:2px solid #0284c7;">
                    <span>TOTAL AKTIVA (ASET)</span>
                    <span style="color:#0369a1;">Rp ${nf.format(n.totalAktiva)}</span>
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
                    <span style="font-weight:600;">Rp ${nf.format(n.saldoHutang)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:12px; font-weight:bold; background:#f8fafc; color:#64748b; margin-bottom:12px;">
                    <span>Total Kewajiban</span>
                    <span>Rp ${nf.format(n.totalKewajiban)}</span>
                </div>

                <div style="font-weight:600; font-size:12px; color:#475569; margin-bottom:6px;">II. Ekuitas / Modal [KODE 3]:</div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9;">
                    <span>• Modal Disetor & Laba Ditahan</span>
                    <span style="font-weight:600;">Rp ${nf.format(n.ekuitasModal)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:13px; border-bottom:1px solid #f1f5f9; color:#15803d;">
                    <span>• Laba Bersih Periode Berjalan</span>
                    <span style="font-weight:700;">Rp ${nf.format(n.labaBerjalan)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:6px 10px; font-size:12px; font-weight:bold; background:#f8fafc; color:#64748b; margin-bottom:12px;">
                    <span>Total Ekuitas</span>
                    <span>Rp ${nf.format(n.totalEkuitas)}</span>
                </div>

                <div style="display:flex; justify-content:space-between; padding:12px 10px; font-size:15px; font-weight:bold; background:#fef3c7; border-radius:6px; margin-top:10px; border-top:2px solid #f59e0b;">
                    <span>TOTAL PASIVA</span>
                    <span style="color:#b45309;">Rp ${nf.format(n.totalPasiva)}</span>
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
    let n = neracaDataGlobal;
    let filename = `Neraca_CBL_${n.asOfLabel.replace(/\s+/g, '_')}`;

    let rows = [
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Kas & Bank', 'Saldo (Rp)': n.saldoKas },
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Piutang Pakan Peternak', 'Saldo (Rp)': n.saldoPiutang },
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'Persediaan Pakan di Gudang (FIFO)', 'Saldo (Rp)': n.saldoPersediaan },
        { 'Kelompok': 'AKTIVA (ASET)', 'Pos Akun': 'TOTAL AKTIVA', 'Saldo (Rp)': n.totalAktiva },
        { 'Kelompok': '', 'Pos Akun': '', 'Saldo (Rp)': '' },
        { 'Kelompok': 'PASIVA (KEWAJIBAN)', 'Pos Akun': 'Hutang Usaha Supplier Pakan', 'Saldo (Rp)': n.saldoHutang },
        { 'Kelompok': 'PASIVA (KEWAJIBAN)', 'Pos Akun': 'TOTAL KEWAJIBAN', 'Saldo (Rp)': n.totalKewajiban },
        { 'Kelompok': '', 'Pos Akun': '', 'Saldo (Rp)': '' },
        { 'Kelompok': 'PASIVA (EKUITAS)', 'Pos Akun': 'Modal Disetor & Laba Ditahan', 'Saldo (Rp)': n.ekuitasModal },
        { 'Kelompok': 'PASIVA (EKUITAS)', 'Pos Akun': 'Laba Bersih Periode Berjalan', 'Saldo (Rp)': n.labaBerjalan },
        { 'Kelompok': 'PASIVA (EKUITAS)', 'Pos Akun': 'TOTAL EKUITAS', 'Saldo (Rp)': n.totalEkuitas },
        { 'Kelompok': '', 'Pos Akun': '', 'Saldo (Rp)': '' },
        { 'Kelompok': 'PASIVA TOTAL', 'Pos Akun': 'TOTAL PASIVA (KEWAJIBAN + EKUITAS)', 'Saldo (Rp)': n.totalPasiva }
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
