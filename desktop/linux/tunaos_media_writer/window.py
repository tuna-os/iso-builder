"""The main window: one AdwNavigationView page per step, rendered from Flow."""

from __future__ import annotations

import json

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from . import APP_ID, strings
from .catalog import host_platform
from .controller import Controller, DriveChoice
from .flow import DriveDestination, FileDestination, Flow, Notice, Source, Stage, Step

_CSS = b"""
.desktop-card { padding: 14px 16px; min-height: 64px; }
flowboxchild { padding: 0; border-radius: 12px; }
flowboxchild:selected { background: none; }
flowboxchild:selected .desktop-card { box-shadow: inset 0 0 0 2px @accent_bg_color; }
.done-page image.icon { color: @success_color; }
"""

_STAGE_LABELS = {
    Stage.PREPARING: strings.STAGE_PREPARING,
    Stage.DOWNLOADING: strings.STAGE_DOWNLOADING,
    Stage.BUILDING: strings.STAGE_BUILDING,
    Stage.WAITING_PERMISSION: strings.STAGE_WAITING_PERMISSION,
    Stage.WRITING: strings.STAGE_WRITING,
    Stage.VERIFYING: strings.STAGE_VERIFYING,
    Stage.CANCELLING: strings.STAGE_CANCELLING,
}

_STEP_PAGES = {
    Step.LOADING: ["choose"],
    Step.CHOOSE: ["choose"],
    Step.DESTINATION: ["choose", "destination"],
    Step.PROGRESS: ["progress"],
    Step.DONE: ["done"],
    Step.ERROR: ["error"],
}


def install_css() -> None:
    provider = Gtk.CssProvider()
    provider.load_from_data(_CSS, -1)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )


def _label(text: str = "", *classes: str, wrap: bool = True, xalign: float | None = None) -> Gtk.Label:
    label = Gtk.Label(label=text, wrap=wrap, justify=Gtk.Justification.CENTER)
    if xalign is not None:
        label.set_xalign(xalign)
        label.set_justify(Gtk.Justification.LEFT)
    for css in classes:
        label.add_css_class(css)
    return label


def _pill(text: str, *classes: str) -> Gtk.Button:
    button = Gtk.Button(label=text, halign=Gtk.Align.CENTER)
    button.add_css_class("pill")
    for css in classes:
        button.add_css_class(css)
    return button


def _page(tag: str, title: str, content: Gtk.Widget, can_pop: bool = True) -> tuple[Adw.NavigationPage, Adw.HeaderBar]:
    header = Adw.HeaderBar()
    view = Adw.ToolbarView(content=content)
    view.add_top_bar(header)
    page = Adw.NavigationPage(title=title, tag=tag, child=view, can_pop=can_pop)
    return page, header


def _scrolled(child: Gtk.Widget) -> Gtk.ScrolledWindow:
    clamp = Adw.Clamp(maximum_size=600, child=child)
    return Gtk.ScrolledWindow(child=clamp, hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True)


def format_size(size: int) -> str:
    return GLib.format_size(size)


class MainWindow(Adw.ApplicationWindow):
    def __init__(self, app: Adw.Application, flow: Flow, controller: Controller) -> None:
        super().__init__(application=app, title=strings.APP_NAME, default_width=640, default_height=720)
        self.flow = flow
        self.controller = controller
        self.platform = host_platform()
        self._rendered_step: Step | None = None
        self._desktop_ids: list[str] = []
        self._base_ids: list[str] = []
        self._drive_rows: list[Gtk.Widget] = []
        self._pulse_id = 0
        self.confirm_dialog: Adw.AlertDialog | None = None
        self.details_dialog: Adw.Dialog | None = None
        self.quit_dialog: Adw.AlertDialog | None = None

        self.toasts = Adw.ToastOverlay()
        self.nav = Adw.NavigationView()
        self.toasts.set_child(self.nav)
        self.set_content(self.toasts)

        self.pages = {
            "choose": self._build_choose(),
            "destination": self._build_destination(),
            "progress": self._build_progress(),
            "done": self._build_done(),
            "error": self._build_error(),
        }
        for page in self.pages.values():
            self.nav.add(page)
        self.nav.replace([self.pages["choose"]])
        self.nav.connect("popped", self._on_popped)
        self._quit_confirmed = False
        self.connect("close-request", self._on_close_request)

        flow.connect(self._render)
        controller.connect_drives(self._render_drives)
        self._render_drives(controller.drives)
        self._render(flow)

    # -- page construction -------------------------------------------
    def _build_choose(self) -> Adw.NavigationPage:
        self.choose_stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)

        spinner = Gtk.Spinner(spinning=True, width_request=32, height_request=32, halign=Gtk.Align.CENTER)
        loading = Adw.StatusPage(title=strings.CATALOG_LOADING, child=spinner)
        self.choose_stack.add_named(loading, "loading")

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18, margin_top=24, margin_bottom=24,
                      margin_start=12, margin_end=12)
        box.append(_label(strings.CHOOSE_TITLE, "title-1"))
        box.append(_label(strings.CHOOSE_DESCRIPTION, "dim-label"))

        self.desktop_flow = Gtk.FlowBox(
            selection_mode=Gtk.SelectionMode.SINGLE, homogeneous=True, min_children_per_line=2,
            max_children_per_line=3, column_spacing=12, row_spacing=12, activate_on_single_click=True,
        )
        self.desktop_flow.connect("selected-children-changed", self._on_desktop_selected)
        box.append(self.desktop_flow)

        group = Adw.PreferencesGroup(title=strings.BASE_GROUP)
        self.base_row = Adw.ComboRow(title=strings.BASE_ROW, model=Gtk.StringList())
        group.add(self.base_row)
        box.append(group)

        buttons = Gtk.Box(spacing=12, halign=Gtk.Align.CENTER, margin_top=12, margin_bottom=12)
        open_button = _pill(strings.OPEN_REQUEST)
        open_button.connect("clicked", lambda *_: self._open_request())
        self.continue_button = _pill(strings.CONTINUE, "suggested-action")
        self.continue_button.connect("clicked", lambda *_: self._continue())
        buttons.append(open_button)
        buttons.append(self.continue_button)
        self.choose_stack.add_named(_scrolled(box), "content")

        page, header = _page("choose", strings.APP_NAME, self.choose_stack, can_pop=False)
        self.choose_view: Adw.ToolbarView = page.get_child()
        self.choose_view.add_bottom_bar(buttons)
        self.choose_view.set_reveal_bottom_bars(False)
        menu = Gio.Menu()
        menu.append(strings.ABOUT, "app.about")
        header.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu, primary=True))
        return page

    def _build_destination(self) -> Adw.NavigationPage:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24, margin_top=24, margin_bottom=24,
                      margin_start=12, margin_end=12)
        self.drives_group = Adw.PreferencesGroup(
            title=strings.DRIVES_GROUP, description=strings.DRIVES_GROUP_DESCRIPTION
        )
        self.no_drives_row = Adw.ActionRow(title=strings.NO_DRIVES_TITLE, subtitle=strings.NO_DRIVES_SUBTITLE)
        self.no_drives_row.add_prefix(Gtk.Image(icon_name="media-removable-symbolic"))
        self.no_drives_row.add_suffix(Gtk.Spinner(spinning=True, valign=Gtk.Align.CENTER))
        self.drives_group.add(self.no_drives_row)
        box.append(self.drives_group)

        save_group = Adw.PreferencesGroup(title=strings.SAVE_GROUP)
        self.save_row = Adw.ActionRow(title=strings.SAVE_ISO, subtitle=strings.SAVE_ISO_SUBTITLE, activatable=True)
        self.save_row.add_prefix(Gtk.Image(icon_name="document-save-symbolic"))
        self.save_row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
        self.save_row.connect("activated", lambda *_: self._choose_save_path())
        save_group.add(self.save_row)
        box.append(save_group)

        self.destination_title = Adw.WindowTitle(title=strings.DESTINATION_TITLE)
        page, header = _page("destination", strings.DESTINATION_TITLE, _scrolled(box))
        header.set_title_widget(self.destination_title)
        return page

    def _build_progress(self) -> Adw.NavigationPage:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, valign=Gtk.Align.CENTER,
                      margin_start=24, margin_end=24, margin_top=24, margin_bottom=24)
        self.stage_label = _label("", "title-1")
        self.source_label = _label("", "dim-label")
        self.progress_bar = Gtk.ProgressBar(margin_top=18)
        self.percent_label = _label("", "numeric", "dim-label")
        self.hint_label = _label("", "caption", "dim-label")
        self.cancel_button = _pill(strings.CANCEL)
        self.cancel_button.set_margin_top(18)
        self.cancel_button.connect("clicked", lambda *_: self.controller.cancel())
        for widget in (self.stage_label, self.source_label, self.progress_bar, self.percent_label,
                       self.hint_label, self.cancel_button):
            box.append(widget)
        page, _header = _page("progress", strings.APP_NAME, Adw.Clamp(maximum_size=480, child=box), can_pop=False)
        return page

    def _build_done(self) -> Adw.NavigationPage:
        buttons = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, halign=Gtk.Align.CENTER)
        self.docs_link = Gtk.LinkButton(uri=strings.INSTALL_DOCS_URL, label=strings.INSTALL_DOCS)
        self.show_file_button = _pill(strings.SHOW_IN_FILES)
        self.show_file_button.connect("clicked", lambda *_: self._show_in_files())
        start_over = _pill(strings.START_OVER, "suggested-action")
        start_over.connect("clicked", lambda *_: self.flow.start_over())
        for widget in (self.docs_link, self.show_file_button, start_over):
            buttons.append(widget)
        self.done_status = Adw.StatusPage(icon_name="emblem-ok-symbolic", child=buttons)
        self.done_status.add_css_class("done-page")
        page, _header = _page("done", strings.APP_NAME, self.done_status, can_pop=False)
        return page

    def _build_error(self) -> Adw.NavigationPage:
        buttons = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, halign=Gtk.Align.CENTER)
        retry = _pill(strings.TRY_AGAIN, "suggested-action")
        retry.connect("clicked", lambda *_: self.flow.retry())
        details = _pill(strings.SHOW_DETAILS)
        details.connect("clicked", lambda *_: self.show_details())
        buttons.append(retry)
        buttons.append(details)
        self.error_status = Adw.StatusPage(icon_name="dialog-error-symbolic", child=buttons)
        page, _header = _page("error", strings.APP_NAME, self.error_status, can_pop=False)
        return page

    # -- rendering ---------------------------------------------------
    def _navigate(self, tags: list[str]) -> None:
        stack = self.nav.get_navigation_stack()
        current = [stack.get_item(i).get_tag() for i in range(stack.get_n_items())]
        if current == tags:
            return
        if current == tags[:-1]:
            self.nav.push(self.pages[tags[-1]])
        elif current[:-1] == tags:
            self.nav.pop()
        else:
            self.nav.replace([self.pages[t] for t in tags])

    def _render(self, flow: Flow) -> None:
        step = flow.step
        entering = step is not self._rendered_step
        self._rendered_step = step
        if entering and step is Step.LOADING:
            self.controller.load_catalog()
        self.controller.watch_drives(step is Step.DESTINATION)

        if step is Step.LOADING:
            self.choose_stack.set_visible_child_name("loading")
            self.choose_view.set_reveal_bottom_bars(False)
        elif step is Step.CHOOSE and entering:
            self._fill_choose()
        elif step is Step.DESTINATION:
            self.destination_title.set_subtitle(flow.source.label if flow.source else "")
        elif step is Step.PROGRESS:
            self._render_progress()
        elif step is Step.DONE and entering:
            self._render_done()
        elif step is Step.ERROR:
            self._render_error()
        self._set_pulsing(step is Step.PROGRESS and flow.fraction is None)
        self._navigate(_STEP_PAGES[step])

        if flow.take_notice() is Notice.CANCELLED:
            self.toasts.add_toast(Adw.Toast(title=strings.CANCELLED))

    def _fill_choose(self) -> None:
        catalog = self.flow.catalog
        if self.desktop_flow.get_child_at_index(0) is None and catalog is not None:
            desktops = catalog.desktops_for(self.platform)
            self._desktop_ids = [d.id for d in desktops]
            for desktop in desktops:
                card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
                card.add_css_class("card")
                card.add_css_class("desktop-card")
                card.append(_label(desktop.label, "heading", xalign=0))
                card.append(_label(desktop.description, "dim-label", xalign=0))
                self.desktop_flow.append(card)
            default = catalog.default_desktop(self.platform)
            if default is None:
                self.continue_button.set_sensitive(False)
                self.toasts.add_toast(Adw.Toast(title=strings.NO_TARGETS_FOR_HOST))
            else:
                self.desktop_flow.select_child(self.desktop_flow.get_child_at_index(self._desktop_ids.index(default)))
        self.choose_stack.set_visible_child_name("content")
        self.choose_view.set_reveal_bottom_bars(True)

    def selected_desktop(self) -> str | None:
        selected = self.desktop_flow.get_selected_children()
        return self._desktop_ids[selected[0].get_index()] if selected else None

    def select_desktop(self, desktop_id: str) -> None:
        self.desktop_flow.select_child(self.desktop_flow.get_child_at_index(self._desktop_ids.index(desktop_id)))

    def _on_desktop_selected(self, *_args) -> None:
        catalog, desktop = self.flow.catalog, self.selected_desktop()
        if catalog is None or desktop is None:
            return
        previous = self._base_ids[self.base_row.get_selected()] if self._base_ids else None
        bases = catalog.bases_for(desktop, self.platform)
        self._base_ids = [b.id for b in bases]
        self.base_row.set_model(Gtk.StringList.new([b.label for b in bases]))
        keep = previous if previous in self._base_ids else catalog.default_base_for(desktop, self.platform)
        if keep is not None:
            self.base_row.set_selected(self._base_ids.index(keep))
        self.continue_button.set_sensitive(bool(bases))

    def _render_drives(self, drives: list[DriveChoice]) -> None:
        for row in self._drive_rows:
            self.drives_group.remove(row)
        self._drive_rows = []
        self.no_drives_row.set_visible(not drives)
        for choice in drives:
            row = Adw.ActionRow(title=choice.label, activatable=True)
            row.set_subtitle(f"{format_size(choice.size_bytes)} · {strings.DRIVE_BUS.get(choice.drive.bus, strings.DRIVE_BUS['other'])}")
            row.add_prefix(Gtk.Image(icon_name="media-removable-symbolic"))
            row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
            row.connect("activated", lambda _row, c=choice: self.confirm_erase(c))
            self.drives_group.add(row)
            self._drive_rows.append(row)

    def _render_progress(self) -> None:
        flow = self.flow
        self.stage_label.set_label(_STAGE_LABELS[flow.stage])
        self.source_label.set_label(flow.source.label if flow.source else "")
        fraction = flow.fraction
        if fraction is not None:
            self.progress_bar.set_fraction(fraction)
            self.percent_label.set_label(strings.PROGRESS_PERCENT.format(percent=int(fraction * 100)))
        else:
            self.percent_label.set_label("")
        if isinstance(flow.destination, FileDestination):
            self.hint_label.set_label(strings.PROGRESS_SAVE.format(path=flow.destination.path))
        else:
            self.hint_label.set_label(strings.PROGRESS_KEEP_PLUGGED)
        self.cancel_button.set_sensitive(flow.stage is not Stage.CANCELLING)

    def _set_pulsing(self, pulsing: bool) -> None:
        if pulsing and not self._pulse_id:
            self._pulse_id = GLib.timeout_add(120, self._pulse)
        elif not pulsing and self._pulse_id:
            GLib.source_remove(self._pulse_id)
            self._pulse_id = 0

    def _pulse(self) -> bool:
        self.progress_bar.pulse()
        return GLib.SOURCE_CONTINUE

    def _render_done(self) -> None:
        if isinstance(self.flow.destination, FileDestination):
            self.done_status.set_title(strings.DONE_FILE_TITLE)
            self.done_status.set_description(
                strings.DONE_FILE_BODY.format(path=GLib.markup_escape_text(self.flow.destination.path))
            )
            self.docs_link.set_visible(False)
            self.show_file_button.set_visible(True)
        else:
            self.done_status.set_title(strings.DONE_DRIVE_TITLE)
            self.done_status.set_description(strings.DONE_DRIVE_BODY)
            self.docs_link.set_visible(True)
            self.show_file_button.set_visible(False)

    def _render_error(self) -> None:
        error = self.flow.error
        kind = error.kind if error else ""
        self.error_status.set_title(strings.ERROR_TITLE.get(kind, strings.ERROR_TITLE_FALLBACK))
        self.error_status.set_description(GLib.markup_escape_text(error.message if error else ""))

    def _on_popped(self, _nav, page) -> None:
        if page.get_tag() == "destination" and self.flow.step is Step.DESTINATION:
            self.flow.back()

    def _on_close_request(self, _window) -> bool:
        """Ask before quitting mid-build/write; True keeps the window open."""
        if self._quit_confirmed or self.flow.step is not Step.PROGRESS:
            return False
        dialog = Adw.AlertDialog(heading=strings.QUIT_HEADING, body=strings.QUIT_BODY)
        dialog.add_response("keep", strings.QUIT_KEEP)
        dialog.add_response("quit", strings.QUIT)
        dialog.set_response_appearance("quit", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("keep")
        dialog.set_close_response("keep")

        def responded(_dialog, response):
            if response == "quit":
                self._quit_confirmed = True
                self.close()

        dialog.connect("response", responded)
        self.quit_dialog = dialog
        dialog.present(self)
        return True

    # -- actions -----------------------------------------------------
    def _continue(self) -> None:
        catalog, desktop = self.flow.catalog, self.selected_desktop()
        if catalog is None or desktop is None or not self._base_ids:
            return
        target = catalog.target_for(self._base_ids[self.base_row.get_selected()], desktop, self.platform)
        if target is not None:
            self.flow.choose(Source.from_target(catalog, target))

    def _open_request(self) -> None:
        dialog = Gtk.FileDialog(title=strings.OPEN_REQUEST_TITLE, modal=True)
        json_filter = Gtk.FileFilter(name=strings.REQUEST_FILTER)
        json_filter.add_mime_type("application/json")
        json_filter.add_pattern("*.json")
        filters = Gio.ListStore.new(Gtk.FileFilter)
        filters.append(json_filter)
        dialog.set_filters(filters)

        def opened(dlg, res):
            try:
                gfile = dlg.open_finish(res)
            except GLib.Error:
                return  # dismissed
            self.open_request(gfile.get_path())

        dialog.open(self, None, opened)

    def open_request(self, path: str | None) -> None:
        try:
            if not path:
                raise ValueError("no local path")
            with open(path, encoding="utf-8") as fh:
                source = Source.from_request(path, json.load(fh))
        except (OSError, ValueError) as exc:
            self.controller.details.append(f"{path}: {exc}")
            self.toasts.add_toast(Adw.Toast(title=strings.REQUEST_UNREADABLE))
            return
        self.flow.choose(source)

    def confirm_erase(self, choice: DriveChoice) -> None:
        dialog = Adw.AlertDialog(
            heading=strings.ERASE_HEADING.format(name=choice.label, size=format_size(choice.size_bytes)),
            body=strings.ERASE_BODY,
        )
        dialog.add_response("cancel", strings.CANCEL)
        dialog.add_response("erase", strings.ERASE)
        dialog.set_response_appearance("erase", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")

        def responded(_dialog, response):
            self.confirm_dialog = None
            if response == "erase" and self.flow.step is Step.DESTINATION:
                self.controller.start(DriveDestination(choice.drive, choice.label))

        dialog.connect("response", responded)
        self.confirm_dialog = dialog
        dialog.present(self)

    def _choose_save_path(self) -> None:
        source = self.flow.source
        dialog = Gtk.FileDialog(title=strings.SAVE_DIALOG_TITLE, modal=True,
                                initial_name=source.save_name if source else "tunaos.iso")
        downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD)
        if downloads:
            dialog.set_initial_folder(Gio.File.new_for_path(downloads))

        def saved(dlg, res):
            try:
                gfile = dlg.save_finish(res)
            except GLib.Error:
                return  # dismissed
            if gfile.get_path():
                self.save_to(gfile.get_path())

        dialog.save(self, None, saved)

    def save_to(self, path: str) -> None:
        if self.flow.step is Step.DESTINATION:
            self.controller.start(FileDestination(path))

    def _show_in_files(self) -> None:
        if isinstance(self.flow.destination, FileDestination):
            launcher = Gtk.FileLauncher(file=Gio.File.new_for_path(self.flow.destination.path))
            launcher.open_containing_folder(self, None, None)

    def show_details(self) -> None:
        text = "\n".join(self.controller.details) or "—"
        buffer = Gtk.TextBuffer(text=text)
        view = Gtk.TextView(buffer=buffer, editable=False, monospace=True, wrap_mode=Gtk.WrapMode.WORD_CHAR,
                            top_margin=12, bottom_margin=12, left_margin=12, right_margin=12)
        header = Adw.HeaderBar()
        copy = Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text=strings.COPY)

        def copy_text(*_):
            self.get_clipboard().set(text)
            self.toasts.add_toast(Adw.Toast(title=strings.COPIED))

        copy.connect("clicked", copy_text)
        header.pack_start(copy)
        toolbar = Adw.ToolbarView(content=Gtk.ScrolledWindow(child=view, vexpand=True))
        toolbar.add_top_bar(header)
        dialog = Adw.Dialog(title=strings.DETAILS_TITLE, child=toolbar, content_width=640, content_height=420)
        dialog.connect("closed", lambda *_: setattr(self, "details_dialog", None))
        self.details_dialog = dialog
        dialog.present(self)


def about(window: Gtk.Window, version: str) -> None:
    dialog = Adw.AboutDialog(
        application_name=strings.APP_NAME, application_icon=APP_ID, version=version,
        website="https://tunaos.org", issue_url="https://github.com/tuna-os/iso-builder/issues",
        license_type=Gtk.License.APACHE_2_0,
    )
    dialog.present(window)

