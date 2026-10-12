// Logika untuk Fitur Manajemen PO Pabrik

let poPakanTerpilih = null;
let listPOMenunggu = [];
window.currentLinkedPOId = null;

// STATE UNTUK CART PO
let poItemsCart = [];
window.poMasterPakan = [];

// Fetch Master Pakan Khusus PO
async function siapkanMasterPakanPO() {
    if (window.poMasterPakan.length > 0) return;
    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/master_pakan?select=*`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (res.ok) {
            window.poMasterPakan = await res.json();
        }
    } catch (e) {
        console.error("Gagal load master_pakan untuk PO", e);
    }
}

// Fungsi Ganti Tab di Layar PO
function switchTabPO(tab) {
    document.querySelectorAll('#page-po .tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('tab-po-' + tab).classList.add('active');

    document.getElementById('view-po-buat').classList.add('hidden');
    document.getElementById('view-po-menunggu').classList.add('hidden');
    document.getElementById('view-po-selesai').classList.add('hidden');

    document.getElementById('view-po-' + tab).classList.remove('hidden');

    if (tab === 'buat') {
        siapkanMasterPakanPO();
    } else if (tab === 'menunggu') {
        muatDaftarPO('MENUNGGU');
    } else if (tab === 'selesai') {
        muatDaftarPO('SELESAI');
    }
}

// Logika Autocomplete Pakan PO
async function bukaAutocompletePO() {
    await siapkanMasterPakanPO();
    filterAutocompletePO();
    document.getElementById('po-autocomplete-list').classList.remove('hidden');
}

function filterAutocompletePO() {
    let input = document.getElementById('po-pakan-alias').value.toLowerCase();
    let listDiv = document.getElementById('po-autocomplete-list');
    listDiv.innerHTML = '';
    
    // Filter window.poMasterPakan yang punya alias
    let matched = window.poMasterPakan.filter(p => p.alias && (p.alias.toLowerCase().includes(input) || p.jenis_pakan.toLowerCase().includes(input)));
    
    if (matched.length === 0) {
        listDiv.innerHTML = '<div class="autocomplete-item" style="color:#888;">Tidak ada data alias</div>';
        return;
    }
    
    matched.forEach(p => {
        let div = document.createElement('div');
        div.className = 'autocomplete-item';
        div.innerHTML = `<strong>${p.alias}</strong> <br><small style="color:#888;">(${p.jenis_pakan}) - Sup: ${p.supplier || '-'}</small>`;
        div.onclick = function() { pilihPakanPO(p); };
        listDiv.appendChild(div);
    });
}

function pilihPakanPO(item) {
    poPakanTerpilih = item;
    document.getElementById('po-pakan-alias').value = item.alias;
    document.getElementById('po-supplier-hint').innerHTML = `<b>${item.supplier || '-'}</b> (${item.kode_sup || '-'}) - ${item.alamat || '-'}`;
    document.getElementById('po-satuan-hint').innerText = item.satuan || 'Kg';
    document.getElementById('po-autocomplete-list').classList.add('hidden');
}

// Sembunyikan autocomplete jika klik di luar
document.addEventListener('click', function(e) {
    if (e.target && e.target.id !== 'po-pakan-alias') {
        let el = document.getElementById('po-autocomplete-list');
        if(el) el.classList.add('hidden');
    }
});

function ubahQtyPO(delta) {
    let input = document.getElementById('po-qty');
    let val = parseInt(input.value) || 0;
    val += delta;
    if (val < 0) val = 0;
    input.value = val;
}

// ==========================================
// FUNGSI CART PO
// ==========================================
function tambahItemPO() {
    if (!poPakanTerpilih) { alert("Pilih pakan (alias) terlebih dahulu!"); return; }
    let qty = parseFloat(document.getElementById('po-qty').value);
    if (isNaN(qty) || qty <= 0) { alert("Qty pesanan harus lebih dari 0!"); return; }
    
    // Cek supplier konsistensi (Opsional, tapi PO idealnya 1 supplier)
    if (poItemsCart.length > 0) {
        if (poItemsCart[0].supplier !== poPakanTerpilih.supplier) {
            alert(`Peringatan: Item ini dari supplier berbeda (${poPakanTerpilih.supplier}) sedangkan keranjang saat ini untuk (${poItemsCart[0].supplier}). Pastikan ini sesuai keinginan.`);
        }
    }

    // Cek apakah item sudah ada di cart
    let existingIndex = poItemsCart.findIndex(i => i.alias === poPakanTerpilih.alias);
    if (existingIndex >= 0) {
        poItemsCart[existingIndex].qty += qty;
    } else {
        poItemsCart.push({
            alias: poPakanTerpilih.alias,
            nama_asli: poPakanTerpilih.jenis_pakan,
            qty: qty,
            satuan: poPakanTerpilih.satuan,
            supplier: poPakanTerpilih.supplier,
            alamat: poPakanTerpilih.alamat,
            kode_sup: poPakanTerpilih.kode_sup
        });
    }

    // Reset Form Input
    document.getElementById('po-pakan-alias').value = '';
    document.getElementById('po-supplier-hint').innerHTML = '';
    document.getElementById('po-qty').value = '0';
    poPakanTerpilih = null;
    
    renderCartPO();
}

function hapusItemPO(index) {
    poItemsCart.splice(index, 1);
    renderCartPO();
}

function renderCartPO() {
    let container = document.getElementById('po-cart-container');
    if (poItemsCart.length === 0) {
        container.innerHTML = '<div style="font-size:12px; color:#888; text-align:center;">Belum ada item pesanan</div>';
        return;
    }
    
    let html = '';
    poItemsCart.forEach((item, index) => {
        html += `
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #ddd; padding:8px 0; font-size:13px;">
            <div>
                <strong>${item.alias}</strong><br>
                <span style="color:#666; font-size:11px;">${item.qty} ${item.satuan}</span>
            </div>
            <span class="material-symbols-outlined" style="color:#e65100; cursor:pointer; font-size:18px;" onclick="hapusItemPO(${index})">delete</span>
        </div>
        `;
    });
    container.innerHTML = html;
}

// Global variable to hold PO data pending confirmation
let pendingPOPayload = null;

// ==========================================
// FUNGSI PREVIEW PO
// ==========================================
async function siapkanPreviewPO() {
    if (poItemsCart.length === 0) { alert("Keranjang pesanan masih kosong!"); return; }
    let tanggal = document.getElementById('po-tanggal').value;
    if (!tanggal) { alert("Pilih tanggal PO!"); return; }
    
    let btn = document.getElementById('btn-buat-po');
    let originalText = btn.innerHTML;
    btn.innerHTML = `<span class="material-symbols-outlined icon-spin">sync</span> Memproses...`;
    btn.disabled = true;

    try {
        let primarySupplier = poItemsCart[0].supplier;
        let primaryAlamat = poItemsCart[0].alamat;
        let primaryKodeSup = poItemsCart[0].kode_sup || 'XXX';

        let thnBln = tanggal.substring(2,7).replace('-',''); 
        let dateObj = new Date(tanggal);
        let tglFormat = ("0" + dateObj.getDate()).slice(-2) + ("0" + (dateObj.getMonth() + 1)).slice(-2) + dateObj.getFullYear().toString().substring(2); 

        let yyyy = dateObj.getFullYear();
        let mm = dateObj.getMonth();
        let lastDay = new Date(yyyy, mm + 1, 0).getDate();
        let startBulan = tanggal.substring(0,7) + "-01";
        let endBulan = `${tanggal.substring(0,7)}-${lastDay}`;
        
        let resNo = await fetch(`${SUPA_URL}/rest/v1/data_po?tanggal_pesan=gte.${startBulan}&tanggal_pesan=lte.${endBulan}&select=no_po`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        
        let urutan = 1;
        if (resNo.ok) {
            let dataNo = await resNo.json();
            urutan = dataNo.length + 1;
        }
        
        let strUrutan = ("000" + urutan).slice(-3);
        let finalNoPO = `PO-${strUrutan}/${tglFormat}`;
        
        let itemNames = poItemsCart.map(i => i.alias).join(', ');
        if(itemNames.length > 20) itemNames = itemNames.substring(0,20) + '...';
        let totalQty = poItemsCart.reduce((sum, i) => sum + i.qty, 0);
        let finalKodeBatch = `PO-${strUrutan} ${tglFormat}-${primaryKodeSup}-(${itemNames} @${totalQty})`;

        let catatan = document.getElementById('po-catatan').value;

        let payload = {
            no_po: finalNoPO,
            kode_batch: finalKodeBatch,
            tanggal_pesan: tanggal,
            supplier: primarySupplier,
            alamat: primaryAlamat,
            items: poItemsCart,
            catatan: catatan,
            status: 'MENUNGGU'
        };

        pendingPOPayload = payload;

        // --- SETUP HTML PREVIEW ---
        document.getElementById('po-print-supplier').innerText = payload.supplier || '-';
        document.getElementById('po-print-alamat').innerText = payload.alamat || '-';
        document.getElementById('po-print-no').innerText = payload.no_po;
        
        let tglObj = new Date(payload.tanggal_pesan);
        let d = tglObj.getDate();
        let m = tglObj.toLocaleString('id-ID', { month: 'long' });
        let y = tglObj.getFullYear();
        let tglText = `${d} ${m} ${y}`;
        
        document.getElementById('po-print-tanggal').innerText = tglText;
        document.getElementById('po-print-ttd-tgl').innerText = `Lembang, ${tglText}`;
        
        let tbody = document.getElementById('po-print-items');
        let tbodyHtml = '';
        
        payload.items.forEach((item, index) => {
            tbodyHtml += `
                <tr>
                    <td>${index + 1}</td>
                    <td class="left-align">${item.alias}</td>
                    <td>${formatAngkaBiasaPO(item.qty)}</td>
                    <td>${item.satuan}</td>
                </tr>
            `;
        });
        
        for(let i = payload.items.length; i < 5; i++) {
            tbodyHtml += `<tr><td></td><td></td><td></td><td></td></tr>`;
        }
        tbody.innerHTML = tbodyHtml;
        document.getElementById('po-print-catatan').innerText = payload.catatan || '';

        // Tampilkan Modal
        document.getElementById('modal-preview-po').classList.remove('hidden');

    } catch (e) {
        console.error(e);
        alert("Terjadi kesalahan: " + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// ==========================================
// FUNGSI KONFIRMASI BUAT & CETAK PO
// ==========================================
async function konfirmasiBuatPO() {
    if (!pendingPOPayload) return;
    let payload = pendingPOPayload;
    
    let btn = document.getElementById('btn_konfirmasi_po');
    let originalText = btn.innerHTML;
    btn.innerHTML = `<span class="material-symbols-outlined icon-spin">sync</span> Memproses...`;
    btn.disabled = true;

    try {
        // 1. Simpan ke Supabase
        let resInsert = await fetch(`${SUPA_URL}/rest/v1/data_po`, {
            method: 'POST',
            headers: {
                'apikey': SUPA_ANON_KEY,
                'Authorization': `Bearer ${SUPA_ANON_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([payload])
        });

        if (!resInsert.ok) {
            let errText = await resInsert.text();
            throw new Error(`Gagal menyimpan PO ke database. Detail: ${errText}`);
        }

        // 📡 Broadcast PO baru ke perangkat lain
        if (typeof window.broadcastRealtimeUpdate === 'function') {
            window.broadcastRealtimeUpdate({
                tipe: 'PO',
                kode_po: payload.kode_po,
                supplier: payload.supplier,
                petugas: payload.petugas || 'Admin'
            });
        }

        // 2. Generate PDF dari Modal yang sedang terbuka (terlihat di layar)
        let element = document.getElementById('po-print-template');
        let modal = document.getElementById('modal-preview-po');
        let wrapper = modal.querySelector('.po-wrapper');
        
        let oriModalPos = modal.style.position;
        let oriWrapperOverflow = wrapper.style.overflowX;
        let oriWrapperScrolling = wrapper.style.WebkitOverflowScrolling;

        modal.style.position = 'absolute';
        wrapper.style.overflowX = 'visible';
        wrapper.style.WebkitOverflowScrolling = 'auto';
        window.scrollTo(0,0);
        
        await new Promise(r => setTimeout(r, 500)); // tunggu render stabil

        let opt = {
            margin:       0,
            filename:     payload.kode_batch + '.pdf',
            image:        { type: 'jpeg', quality: 0.98 },
            html2canvas:  { scale: 2, useCORS: true },
            jsPDF:        { unit: 'mm', format: 'a5', orientation: 'portrait' }
        };

        let worker = html2pdf().set(opt).from(element);
        let pdfBlob = await worker.outputPdf('blob');
        
        modal.style.position = oriModalPos;
        wrapper.style.overflowX = oriWrapperOverflow;
        wrapper.style.WebkitOverflowScrolling = oriWrapperScrolling;

        // 3. Web Share API
        let file = new File([pdfBlob], payload.kode_batch + '.pdf', { type: 'application/pdf' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
                files: [file],
                title: 'Purchase Order',
                text: 'Berikut adalah Purchase Order baru.'
            });
        } else {
            // Fallback download
            let url = URL.createObjectURL(pdfBlob);
            let a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        alert("PO Berhasil Dibuat dan Disimpan!");
        
        // Reset & Tutup Modal
        document.getElementById('modal-preview-po').classList.add('hidden');
        pendingPOPayload = null;
        poItemsCart = [];
        renderCartPO();
        document.getElementById('po-catatan').value = "";
        switchTabPO('menunggu');

    } catch (e) {
        console.error(e);
        alert("Terjadi kesalahan: " + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function formatAngkaBiasaPO(num) {
    if (!num) return "0";
    let str = num.toString().replace('.', ',');
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ==========================================
// FUNGSI DAFTAR PO (Menunggu & Selesai)
// ==========================================
async function muatDaftarPO(statusFilter) {
    let container = document.getElementById(statusFilter === 'MENUNGGU' ? 'po-menunggu-list' : 'po-selesai-list');
    container.innerHTML = '<div class="loader">Memuat Data...</div>';
    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/data_po?status=eq.${statusFilter}&order=tanggal_pesan.desc`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        if (!res.ok) throw new Error("Gagal fetch data");
        let data = await res.json();
        
        if (statusFilter === 'MENUNGGU') listPOMenunggu = data;

        if (data.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#888; font-size:12px;">Tidak ada data PO ${statusFilter.toLowerCase()}.</div>`;
            return;
        }

        let htmlRows = '';
        data.forEach(po => {
            // Tgl Buat (Created At)
            let dBuat = new Date(po.created_at);
            let tglBuat = ("0" + dBuat.getDate()).slice(-2) + "-" + ("0" + (dBuat.getMonth() + 1)).slice(-2) + "-" + dBuat.getFullYear();
            
            // Tgl Pesan
            let dPesan = new Date(po.tanggal_pesan);
            let tglPesan = ("0" + dPesan.getDate()).slice(-2) + "-" + ("0" + (dPesan.getMonth() + 1)).slice(-2) + "-" + dPesan.getFullYear();

            // Status H- / H+ untuk MENUNGGU
            let htmlStatus = '';
            if (statusFilter === 'MENUNGGU') {
                let today = new Date();
                today.setHours(0,0,0,0);
                let tDate = new Date(po.tanggal_pesan);
                tDate.setHours(0,0,0,0);
                let diff = Math.ceil((today - tDate) / (1000*60*60*24));
                
                if (diff < 0) {
                    htmlStatus = `<span style="color:#2196F3; font-weight:bold;">H${diff}</span>`; // H-
                } else if (diff > 0) {
                    htmlStatus = `<span style="color:#F44336; font-weight:bold;">H+${diff}</span>`; // H+
                } else {
                    htmlStatus = `<span style="color:#4CAF50; font-weight:bold;">Hari H</span>`;
                }
            } else {
                htmlStatus = `<span style="color:#8AA624; font-weight:bold;">Selesai</span>`;
            }

            // Render Items
            let itemsText = '';
            po.items.forEach(i => {
                let selisihHtml = '';
                if (typeof i.selisih !== 'undefined') {
                    if (i.selisih < 0) selisihHtml = ` <span style="color:red; font-size:11px; font-weight:bold;">(Kurang ${Math.abs(i.selisih)})</span>`;
                    else if (i.selisih > 0) selisihHtml = ` <span style="color:green; font-size:11px; font-weight:bold;">(Lebih ${i.selisih})</span>`;
                    else selisihHtml = ` <span style="color:#8AA624; font-size:11px; font-weight:bold;">(Pas)</span>`;
                }
                
                if (typeof i.qty_masuk !== 'undefined') {
                    itemsText += `<div style="margin-bottom:4px;">${i.alias}<br><span style="font-size:10px; color:#555;">Pesan: <b>${i.qty}</b> | Dtg: <b>${i.qty_masuk} ${i.satuan}</b>${selisihHtml}</span></div>`;
                } else {
                    itemsText += `<div style="margin-bottom:4px;">${i.alias} - <b>${i.qty} ${i.satuan}</b></div>`;
                }
            });

            // Tgl Masuk untuk SELESAI
            let tglMasukHtml = '';
            if (statusFilter === 'SELESAI' && po.tanggal_selesai) {
                let d2 = new Date(po.tanggal_selesai);
                tglMasukHtml = ("0" + d2.getDate()).slice(-2) + "-" + ("0" + (d2.getMonth() + 1)).slice(-2) + "-" + d2.getFullYear();
            }

            htmlRows += `
            <tr style="border-bottom:1px solid #ddd; background:white;">
                <td style="padding:10px; border:1px solid #ddd; white-space:nowrap; vertical-align:top;">${tglBuat}</td>
                <td style="padding:10px; border:1px solid #ddd; white-space:nowrap; font-weight:bold; color:#0f2c59; vertical-align:top;">${po.no_po}</td>
                <td style="padding:10px; border:1px solid #ddd; white-space:nowrap; vertical-align:top;">${tglPesan}</td>
                ${statusFilter === 'SELESAI' ? `<td style="padding:10px; border:1px solid #ddd; white-space:nowrap; vertical-align:top;">${tglMasukHtml}</td>` : ''}
                <td style="padding:10px; border:1px solid #ddd; vertical-align:top;"><b>${po.supplier}</b></td>
                <td style="padding:10px; border:1px solid #ddd; vertical-align:top;">
                    ${itemsText}
                    ${po.catatan ? `<div style="font-size:10px; background:#fff3cd; padding:4px; margin-top:4px; border-radius:4px;">Catatan: ${po.catatan}</div>` : ''}
                </td>
                <td style="padding:10px; border:1px solid #ddd; text-align:center; vertical-align:top;">${htmlStatus}</td>
                ${statusFilter === 'MENUNGGU' ? `
                <td style="padding:10px; border:1px solid #ddd; text-align:center; vertical-align:top;">
                    <div style="display:flex; flex-direction:column; gap:6px;">
                        <button onclick="voidPO('${po.id}')" style="background:white; color:#F44336; border:1px solid #F44336; padding:6px; border-radius:6px; font-size:10px; font-weight:bold; cursor:pointer; width:100%;">Batal</button>
                        <button onclick="kirimUlangPDF('${po.id}')" style="background:#4A90E2; color:white; border:none; padding:6px; border-radius:6px; font-size:10px; font-weight:bold; cursor:pointer; width:100%;">Share</button>
                    </div>
                </td>
                ` : ''}
            </tr>
            `;
        });

        let fullHtml = `
        <div style="margin-bottom:15px;">
            <input type="text" id="search-po-${statusFilter}" placeholder="Cari Kode PO, Supplier, atau Jenis Pakan..." style="width:100%; padding:12px; border-radius:8px; border:1px solid #ccc; font-size:13px; box-sizing:border-box;" onkeyup="filterTablePO(this, 'table-po-${statusFilter}')">
        </div>
        <div style="overflow-x:auto; border-radius:8px; box-shadow:0 2px 4px rgba(0,0,0,0.05);">
            <table id="table-po-${statusFilter}" style="width:100%; border-collapse:collapse; font-size:12px; min-width:800px;">
                <thead>
                    <tr>
                        <th style="padding:12px; border:1px solid #ddd; white-space:nowrap; background:#0f2c59; color:white; text-align:center;">Tgl Buat</th>
                        <th style="padding:12px; border:1px solid #ddd; white-space:nowrap; background:#0f2c59; color:white; text-align:center;">Kode PO</th>
                        <th style="padding:12px; border:1px solid #ddd; white-space:nowrap; background:#0f2c59; color:white; text-align:center;">Tgl Pesan</th>
                        ${statusFilter === 'SELESAI' ? '<th style="padding:12px; border:1px solid #ddd; white-space:nowrap; background:#0f2c59; color:white; text-align:center;">Tgl Masuk</th>' : ''}
                        <th style="padding:12px; border:1px solid #ddd; min-width:150px; background:#0f2c59; color:white; text-align:center;">Supplier</th>
                        <th style="padding:12px; border:1px solid #ddd; min-width:200px; background:#0f2c59; color:white; text-align:center;">Item Pakan</th>
                        <th style="padding:12px; border:1px solid #ddd; white-space:nowrap; background:#0f2c59; color:white; text-align:center;">Status</th>
                        ${statusFilter === 'MENUNGGU' ? '<th style="padding:12px; border:1px solid #ddd; background:#0f2c59; color:white; text-align:center;">Aksi</th>' : ''}
                    </tr>
                </thead>
                <tbody>
                    ${htmlRows}
                </tbody>
            </table>
        </div>
        `;
        
        container.innerHTML = fullHtml;
    } catch (e) {
        container.innerHTML = `<div style="color:red; font-size:12px; text-align:center;">Gagal memuat: ${e.message}</div>`;
    }
}

window.filterTablePO = function(input, tableId) {
    let filter = input.value.toLowerCase();
    let table = document.getElementById(tableId);
    if (!table) return;
    let trs = table.getElementsByTagName("tbody")[0].getElementsByTagName("tr");
    
    for (let i = 0; i < trs.length; i++) {
        let text = trs[i].textContent || trs[i].innerText;
        if (text.toLowerCase().indexOf(filter) > -1) {
            trs[i].style.display = "";
        } else {
            trs[i].style.display = "none";
        }
    }
}

async function voidPO(id) {
    if (!confirm("Apakah Anda yakin ingin membatalkan pesanan PO ini? Status akan menjadi BATAL.")) return;
    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/data_po?id=eq.${id}`, {
            method: 'PATCH',
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'BATAL' })
        });
        if(res.ok) {
            alert("PO berhasil dibatalkan.");
            muatDaftarPO('MENUNGGU');
        } else {
            alert("Gagal membatalkan PO.");
        }
    } catch (e) { alert(e.message); }
}

async function kirimUlangPDF(id) {
    let po = listPOMenunggu.find(p => p.id == id);
    if(po) {
        await generateAndSharePDF(po);
    }
}


// ==========================================
// INTEGRASI BARANG MASUK (TARIK PO)
// ==========================================
function bukaModalTarikPO() {
    document.getElementById('modal-tarik-po').style.display = 'flex';
    muatDaftarTarikPO();
}
function tutupModalTarikPO() {
    document.getElementById('modal-tarik-po').style.display = 'none';
}

async function muatDaftarTarikPO() {
    let container = document.getElementById('list-tarik-po');
    container.innerHTML = '<div class="loader">Mencari PO Menunggu...</div>';
    try {
        let res = await fetch(`${SUPA_URL}/rest/v1/data_po?status=eq.MENUNGGU&order=tanggal_pesan.asc`, {
            headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` }
        });
        let data = await res.json();
        
        if (data.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#888; font-size:12px;">Tidak ada PO yang sedang menunggu.</div>`;
            return;
        }

        let html = '';
        data.forEach(po => {
            let itemsHtml = '';
            po.items.forEach(i => {
                itemsHtml += `<div>${i.alias} - <b>${i.qty} ${i.satuan}</b></div>`;
            });
            
            html += `
            <div style="background:#f9f9f9; border:1px solid #DBE4C9; border-radius:8px; padding:12px; margin-bottom:10px; cursor:pointer;" onclick='pilihTarikPO(${JSON.stringify(po)})'>
                <div style="font-size:13px; font-weight:bold; color:#8AA624; margin-bottom:5px;">${po.no_po}</div>
                <div style="font-size:11px; color:#555; margin-bottom:5px;">${po.tanggal_pesan} | ${po.supplier}</div>
                <div style="font-size:12px; color:#333;">
                    ${itemsHtml}
                </div>
            </div>
            `;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div style="color:red; font-size:12px; text-align:center;">Gagal memuat: ${e.message}</div>`;
    }
}

async function pilihTarikPO(po) {
    // Set Global Linked ID
    window.currentLinkedPOId = po.id;
    
    // Auto-fill Input Form
    document.getElementById('tanggal').value = new Date().toISOString().split('T')[0];
    
    // "nama supplier itu harusnya penempatannya ada di kolom dari. dan nama supplier nya pakai Kode_sup aja"
    let kodeSup = po.items && po.items.length > 0 ? po.items[0].kode_sup : po.supplier;
    document.getElementById('ongkir').value = kodeSup;
    
    // Loop semua item di PO untuk mengisi input DOM
    po.items.forEach(item => {
        let matchedIndex = -1;
        let itemNameTarget = (item.nama_asli || item.alias || "").trim().toLowerCase();
        
        if (typeof currentItems !== 'undefined' && currentItems.length > 0) {
            matchedIndex = currentItems.findIndex(i => (i.nama || "").trim().toLowerCase() === itemNameTarget);
        }
        
        if (matchedIndex === -1) {
            let domItems = document.querySelectorAll('.item-name');
            for(let i=0; i<domItems.length; i++) {
                if(domItems[i].innerText.trim().toLowerCase() === itemNameTarget) {
                    matchedIndex = i;
                    break;
                }
            }
        }

        if (matchedIndex >= 0) {
            let elQty = document.getElementById('qty-' + matchedIndex);
            if (elQty) {
                elQty.value = item.qty;
                elQty.setAttribute('data-total', item.qty);
                if (typeof hitungCalc === 'function') {
                    hitungCalc(matchedIndex);
                }
            }
        }
    });

    if (typeof hitungTotalKeseluruhan === 'function') hitungTotalKeseluruhan();
    
    document.getElementById('catatan').value = `Penerimaan dari ${po.no_po}`;
    
    // UX Indicator: Show which PO is active
    let activeIndicator = document.getElementById('active-po-indicator');
    if (!activeIndicator) {
        activeIndicator = document.createElement('div');
        activeIndicator.id = 'active-po-indicator';
        activeIndicator.style = 'background:#e8f0d8; color:#1a5c40; padding:6px 10px; border-radius:8px; font-size:11px; font-weight:bold; display:flex; justify-content:space-between; align-items:center; flex:1;';
        let containerTarik = document.getElementById('container-tarik-po');
        containerTarik.appendChild(activeIndicator);
    }
    activeIndicator.innerHTML = `<span><span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; margin-right:5px;">link</span> Terhubung dengan ${po.no_po}</span> <span style="cursor:pointer; color:red; padding:4px 8px; border:1px solid red; border-radius:4px;" onclick="batalTarikPO()">Batal</span>`;

    tutupModalTarikPO();
}

window.batalTarikPO = function() {
    window.currentLinkedPOId = null;
    document.getElementById('ongkir').value = '';
    document.getElementById('catatan').value = '';
    if (typeof currentItems !== 'undefined') {
        currentItems.forEach((item, index) => {
            let elQty = document.getElementById('qty-' + index);
            if (elQty) {
                elQty.value = '';
                elQty.setAttribute('data-total', '0');
                if (typeof hitungCalc === 'function') {
                    hitungCalc(index);
                }
            }
        });
    }
    let activeIndicator = document.getElementById('active-po-indicator');
    if (activeIndicator) activeIndicator.remove();
};

// Intercept setelah transaksi_pakan berhasil di-upload
async function cekUpdateStatusPOLinked(payloads, abortSignal = null) {
    for (let pl of payloads) {
        if (pl.status === 'Masuk' && pl.po_id) {
            try {
                // 1. Ambil data PO aslinya dulu untuk melihat json items-nya
                let getOpt = { headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}` } };
                if (abortSignal) getOpt.signal = abortSignal;
                
                let res = await fetch(`${SUPA_URL}/rest/v1/data_po?id=eq.${pl.po_id}`, getOpt);
                if (!res.ok) continue;
                let data = await res.json();
                
                if (data && data.length > 0) {
                    let po = data[0];
                    let currentItems = po.items || [];
                    
                    // 2. Suntikkan qty_masuk dan hitung selisih
                    let newItems = currentItems.map(item => {
                        let itemNameTarget = (item.nama_asli || item.alias || "").trim().toLowerCase();
                        
                        // Cari pakan di keranjang Laporan Harian (pl.items) yang sesuai
                        let matchedKey = Object.keys(pl.items).find(k => k.trim().toLowerCase() === itemNameTarget);
                        
                        let qtyMasuk = matchedKey ? (parseFloat(pl.items[matchedKey]) || 0) : 0;
                        let qtyPesan = parseFloat(item.qty) || 0;
                        let selisih = qtyMasuk - qtyPesan;

                        return {
                            ...item,
                            qty_masuk: qtyMasuk,
                            selisih: selisih
                        };
                    });

                    // 3. Update status & json items kembali ke tabel PO
                    let patchOpt = {
                        method: 'PATCH',
                        headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${SUPA_ANON_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            status: 'SELESAI', 
                            tanggal_selesai: pl.tanggal ? new Date(pl.tanggal).toISOString() : new Date().toISOString(),
                            items: newItems
                        })
                    };
                    if (abortSignal) patchOpt.signal = abortSignal;

                    await fetch(`${SUPA_URL}/rest/v1/data_po?id=eq.${pl.po_id}`, patchOpt);
                }
            } catch (e) { console.error("Gagal update status PO", e); }
        }
    }
    window.currentLinkedPOId = null;
}
