using Xunit;

namespace TunaOS.MediaWriter.Core.Tests;

public class LaunchLinkTests
{
    [Theory]
    [InlineData("yellowfin:gnome:linux/amd64")]
    [InlineData("albacore:gnome-hwe:linux/amd64/v2")]
    [InlineData("flounder-sid:xfce:linux/arm64")]
    public void ValidTargetIds(string id) => Assert.Equal(id, LaunchLink.TargetId(id));

    [Theory]
    [InlineData("")]
    [InlineData("yellowfin")]
    [InlineData("yellowfin:gnome")]
    [InlineData("yellowfin:gnome:linux")]
    [InlineData("Yellowfin:gnome:linux/amd64")]
    [InlineData("yellowfin:gnome:linux/amd64 ")]
    [InlineData("yellowfin:gnome:linux/amd64\n")]
    [InlineData("--fake-helper")]
    [InlineData("../../etc:passwd:linux/amd64")]
    [InlineData("a:b:c/d:e")]
    public void InvalidTargetIds(string id) =>
        Assert.Equal(LinkFailure.InvalidTargetId, Assert.Throws<LaunchLinkException>(() => LaunchLink.TargetId(id)).Failure);

    [Theory]
    [InlineData("tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64", "yellowfin:gnome:linux/amd64")]
    [InlineData("tunaos-media-writer://build?target=albacore%3Agnome-hwe%3Alinux%2Famd64%2Fv2", "albacore:gnome-hwe:linux/amd64/v2")]
    [InlineData("tunaos-media-writer://build?target=yellowfin:gnome:linux/amd64", "yellowfin:gnome:linux/amd64")]
    // Some browsers add a slash before the query.
    [InlineData("tunaos-media-writer://build/?target=yellowfin%3Agnome%3Alinux%2Famd64", "yellowfin:gnome:linux/amd64")]
    [InlineData("TUNAOS-MEDIA-WRITER://BUILD?target=yellowfin%3Agnome%3Alinux%2Famd64", "yellowfin:gnome:linux/amd64")]
    public void UrlEncodedAndPlainLinks(string link, string expected) => Assert.Equal(expected, LaunchLink.TargetIdFromUri(link));

    [Theory]
    [InlineData("https://iso.tunaos.org/?target=yellowfin%3Agnome%3Alinux%2Famd64", LinkFailure.NotALink)]
    [InlineData(@"C:\Users\u\Downloads\build-request.json", LinkFailure.NotALink)]
    [InlineData("not a link", LinkFailure.NotALink)]
    [InlineData("tunaos-media-writer://write?target=yellowfin%3Agnome%3Alinux%2Famd64", LinkFailure.UnknownAction)]
    [InlineData("tunaos-media-writer://build/extra?target=yellowfin%3Agnome%3Alinux%2Famd64", LinkFailure.UnknownAction)]
    [InlineData("tunaos-media-writer://build", LinkFailure.MissingTarget)]
    [InlineData("tunaos-media-writer://build?target=", LinkFailure.MissingTarget)]
    [InlineData("tunaos-media-writer://build?target=a%3Ab%3Alinux%2Famd64&target=c%3Ad%3Alinux%2Famd64", LinkFailure.MissingTarget)]
    [InlineData("tunaos-media-writer://build?target=not-a-target", LinkFailure.InvalidTargetId)]
    [InlineData("tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64%0A", LinkFailure.InvalidTargetId)]
    public void RefusedLinks(string link, LinkFailure expected) =>
        Assert.Equal(expected, Assert.Throws<LaunchLinkException>(() => LaunchLink.TargetIdFromUri(link)).Failure);

    [Theory]
    [InlineData("tunaos-media-writer://build?target=x", true)]
    [InlineData("TUNAOS-MEDIA-WRITER:build", true)]
    [InlineData("--target", false)]
    [InlineData(@"C:\smoke", false)]
    public void RecognisesLinkArguments(string arg, bool expected) => Assert.Equal(expected, LaunchLink.IsLink(arg));
}
