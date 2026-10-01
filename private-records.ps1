param(
    [string]$ArchivePath=(Join-Path $env:USERPROFILE 'Naki-Private\jotform-final-before-clear-20261001.json.dpapi'),
    [switch]$VerifyOnly,
    [switch]$VerifyLayout
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security

function Read-NakiArchive([string]$Path) {
    $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($Path),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        $nodeRuntime=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if(!(Test-Path -LiteralPath $nodeRuntime)){$nodeRuntime=(Get-Command node -ErrorAction Stop).Source}
        $view=([Text.Encoding]::UTF8.GetString($bytes)|& $nodeRuntime (Join-Path $PSScriptRoot 'private-records-normalise.mjs')|Out-String)
        if($LASTEXITCODE -ne 0){throw 'Saved records could not be read.'}
        return $view | ConvertFrom-Json -AsHashtable -Depth 30
    }
    finally { [Array]::Clear($bytes,0,$bytes.Length) }
}
function Format-NakiAnswer($Value) {
    if($null -eq $Value){return ''}
    if($Value -is [Collections.IDictionary]){
        return (($Value.GetEnumerator() | ForEach-Object {if($null -ne $_.Value -and [string]$_.Value -ne ''){'{0}: {1}' -f $_.Key,(Format-NakiAnswer $_.Value)}}) -join '; ')
    }
    if($Value -is [array]){return (($Value | ForEach-Object {Format-NakiAnswer $_}) -join '; ')}
    return [string]$Value
}
function Get-NakiSearchLiteral([string]$Text) {
    $builder=[Text.StringBuilder]::new()
    foreach($char in $Text.ToCharArray()){
        $escaped=switch([string]$char){"'" {"''"}; '[' {'[[]'}; ']' {'[]]'}; '%' {'[%]'}; '*' {'[*]'}; default {[string]$char}}
        [void]$builder.Append($escaped)
    }
    return $builder.ToString()
}
function ConvertTo-NakiTable($Archive) {
    $table=[Data.DataTable]::new('Saved records')
    foreach($column in @('Date','Customer','Address','Phone','Appliances','Original total','Source status','Form','Record ID','Search','Details')){[void]$table.Columns.Add($column,[string])}
    foreach($values in $Archive.rows){
        $row=$table.NewRow()
        $row.ItemArray=$values
        $table.Rows.Add($row)
    }
    return ,$table
}

try {
    $archive=Read-NakiArchive $ArchivePath
    if(!$archive.formsCount -or !$archive.rows){throw 'This file does not contain a complete Jotform records archive.'}
    $table=ConvertTo-NakiTable $archive
    if($table.Rows.Count -ne $archive.rows.Count){throw 'The saved-record count did not verify.'}
    if($VerifyOnly){
        $test=[Data.DataTable]::new();[void]$test.Columns.Add('Search');[void]$test.Rows.Add("Test's [100%]* record")
        foreach($term in @("Test's",'[100%]','*','record')){$test.DefaultView.RowFilter="Search LIKE '%$(Get-NakiSearchLiteral $term)%'";if($test.DefaultView.Count -ne 1){throw 'Search escaping did not verify.'}}
        [pscustomobject]@{Records=$table.Rows.Count;Forms=$archive.formsCount;UniqueIDs=@($table.Rows|ForEach-Object {$_['Record ID']}|Sort-Object -Unique).Count;SearchVerified=$true;PlaintextFilesWritten=0}|ConvertTo-Json -Compress
        $table.Dispose();return
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $window=[Windows.Forms.Form]::new();$window.Text='Naki private records';$window.Size=[Drawing.Size]::new(1120,780);$window.MinimumSize=[Drawing.Size]::new(880,650);$window.StartPosition='CenterScreen';$window.Font=[Drawing.Font]::new('Segoe UI',10)
    $layout=[Windows.Forms.TableLayoutPanel]::new();$layout.Dock='Fill';$layout.Padding=[Windows.Forms.Padding]::new(18);$layout.ColumnCount=1;$layout.RowCount=6
    foreach($height in @(45,40,32,0,0,54)){$style=[Windows.Forms.RowStyle]::new();if($height){$style.SizeType='Absolute';$style.Height=$height}else{$style.SizeType='Percent';$style.Height=50};[void]$layout.RowStyles.Add($style)}
    $heading=[Windows.Forms.Label]::new();$heading.Text='Your saved Jotform records';$heading.Font=[Drawing.Font]::new('Segoe UI',18,[Drawing.FontStyle]::Bold);$heading.Dock='Fill'
    $search=[Windows.Forms.TextBox]::new();$search.Dock='Fill';$search.PlaceholderText='Search a customer, address, appliance or any saved answer'
    $count=[Windows.Forms.Label]::new();$count.Dock='Fill';$count.Text="$($table.Rows.Count.ToString('N0')) records. Original answers are preserved. Earnings use the corrected figures in your Naki app."
    $grid=[Windows.Forms.DataGridView]::new();$grid.BindingContext=[Windows.Forms.BindingContext]::new();$grid.Dock='Fill';$grid.ReadOnly=$true;$grid.AllowUserToAddRows=$false;$grid.AllowUserToDeleteRows=$false;$grid.MultiSelect=$false;$grid.SelectionMode='FullRowSelect';$grid.AutoSizeColumnsMode='Fill';$grid.RowHeadersVisible=$false;$grid.DataSource=$table.DefaultView
    foreach($column in @('Search','Details')){$grid.Columns[$column].Visible=$false}
    $grid.Columns['Address'].FillWeight=160;$grid.Columns['Customer'].FillWeight=120;$grid.Columns['Appliances'].FillWeight=145;$grid.Columns['Record ID'].FillWeight=120
    $details=[Windows.Forms.RichTextBox]::new();$details.Dock='Fill';$details.ReadOnly=$true;$details.DetectUrls=$false;$details.BackColor=[Drawing.Color]::White
    $buttons=[Windows.Forms.FlowLayoutPanel]::new();$buttons.Dock='Fill';$buttons.FlowDirection='RightToLeft'
    $close=[Windows.Forms.Button]::new();$close.Text='Lock and close';$close.Size=[Drawing.Size]::new(165,40)
    $copy=[Windows.Forms.Button]::new();$copy.Text='Copy encrypted archive';$copy.Size=[Drawing.Size]::new(220,40)
    [void]$buttons.Controls.Add($close);[void]$buttons.Controls.Add($copy)
    foreach($control in @($heading,$search,$count,$grid,$details,$buttons)){[void]$layout.Controls.Add($control)};[void]$window.Controls.Add($layout)
    $search.Add_TextChanged({$table.DefaultView.RowFilter="Search LIKE '%$(Get-NakiSearchLiteral $search.Text)%'";$count.Text="$($table.DefaultView.Count.ToString('N0')) of $($table.Rows.Count.ToString('N0')) records. Original source values."})
    $grid.Add_SelectionChanged({if($grid.CurrentRow -and $grid.CurrentRow.DataBoundItem){$record=$grid.CurrentRow.DataBoundItem;$details.Text="Record: $($record['Record ID'])`r`nForm: $($record['Form'])`r`nSaved: $($record['Date'])`r`nSource status: $($record['Source status'])`r`n`r`n$($record['Details'])"}else{$details.Clear()}})
    $close.Add_Click({$window.Close()})
    $copy.Add_Click({
        $dialog=[Windows.Forms.SaveFileDialog]::new();$dialog.Title='Save a protected copy';$dialog.Filter='Encrypted Naki records (*.dpapi)|*.dpapi';$dialog.FileName='Naki Jotform records 2026-10-01.dpapi';$dialog.OverwritePrompt=$true
        try {if($dialog.ShowDialog() -eq 'OK'){
            Copy-Item -LiteralPath $ArchivePath -Destination $dialog.FileName
            if((Get-FileHash -LiteralPath $ArchivePath).Hash -ne (Get-FileHash -LiteralPath $dialog.FileName).Hash){throw 'The copied archive did not verify.'}
            [void][Windows.Forms.MessageBox]::Show('Encrypted copy saved. Open it with this Windows account.','Naki records')
        }}catch{[void][Windows.Forms.MessageBox]::Show('Could not save a verified copy. Your original archive is safe.','Naki records')}
        finally{$dialog.Dispose()}
    })
    if($VerifyLayout){$window.CreateControl();$window.PerformLayout();if($grid.Columns.Count -ne 11 -or $grid.Columns['Details'].Visible -or !$grid.ReadOnly){throw 'Record viewer controls did not verify.'};[pscustomobject]@{LayoutConstructed=$true;Columns=$grid.Columns.Count;Records=$table.Rows.Count;ReadOnly=$grid.ReadOnly;DetailsHidden=$true}|ConvertTo-Json -Compress}
    else {[void]$window.ShowDialog()}
    $grid.DataSource=$null;$details.Clear();$table.Clear();$table.Dispose();$archive=$null;$window.Dispose()
} catch {
    if($VerifyOnly -or $VerifyLayout){throw}
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show('Could not open the protected records. Use the Windows account that created the archive, and keep the original file safe.','Naki private records')
    exit 1
}
