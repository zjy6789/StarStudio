// Run against the project's test document, never against a user's photograph.
var source = app.activeDocument;
if (source.name.indexOf("PS-test-") !== 0) throw new Error("Open the project PS-test document first");
var root = File($.fileName).parent.parent;
var out = new Folder(root + "/artifacts");
var tag = source.layers.length;
var names = [];
for (var i = 0; i < source.layers.length; i++) {
    names.push(i + "\t" + source.layers[i].name + "\t" + source.layers[i].visible);
    var copy = source.duplicate("PS-test-export", false);
    for (var j = 0; j < copy.layers.length; j++) copy.layers[j].visible = j === i;
    copy.flatten();
    var tiff = new TiffSaveOptions();
    tiff.imageCompression = TIFFEncoding.NONE;
    tiff.embedColorProfile = true;
    copy.saveAs(new File(out + "/ps-" + tag + "-layer-" + i + ".tif"), tiff, true, Extension.LOWERCASE);
    copy.close(SaveOptions.DONOTSAVECHANGES);
}
app.activeDocument = source;
var report = new File(out + "/ps-" + tag + "-layers.tsv");
report.encoding = "UTF-8"; report.open("w"); report.write(names.join("\n")); report.close();
var psd = new PhotoshopSaveOptions(); psd.layers = true; psd.embedColorProfile = true;
source.saveAs(new File(out + "/PS-test-result.psd"), psd, true, Extension.LOWERCASE);
names.join(";");
